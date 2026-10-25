import type { QueueRefusal } from "../host.ts";
import {
  bodyOf,
  fieldsOf,
  type JsonSchema,
  json,
  missingSession,
  type RouteFamily,
  type RouteSpec,
} from "./family.ts";

const moveBody: JsonSchema = {
  type: "object",
  required: ["to"],
  properties: {
    to: {
      type: "integer",
      minimum: 0,
      description: "The prompt's new 0-based place in the queue, as `queue.changed` lists it.",
    },
  },
  additionalProperties: false,
};

const missingItemResponse =
  'No session has that id, or `{ error: "no queued prompt has that id" }`.';

export const queueRoutes = [
  {
    method: "POST",
    path: "/sessions/{id}/queue/{itemId}/move",
    operationId: "moveQueuedPrompt",
    summary:
      "Move one prompt waiting behind the running turn to another place in the queue, as the terminal does with alt+arrow while it edits the queue. `itemId` is the prompt's `id` from `queue.changed`. Steered prompts always run before queued ones, so a move that would put a queued prompt ahead of a steered one, or a steered one behind a queued one, is refused. `queue.changed` follows with the new order.",
    authenticated: true,
    requestBody: moveBody,
    responses: {
      "200": "`{ queued }`: the whole queue after the move, as `queue.changed` carries it.",
      "400": "The body is not `{ to }` with a non-negative integer.",
      "404": missingItemResponse,
      "409": "`to` is past the end of the queue, or the move would cross a steered prompt.",
    },
  },
  {
    method: "DELETE",
    path: "/sessions/{id}/queue/{itemId}",
    operationId: "cancelQueuedPrompt",
    summary:
      "Drop one prompt waiting behind the running turn before it runs. `itemId` is the prompt's `id` from `queue.changed`, which follows without it.",
    authenticated: true,
    responses: {
      "200": "`{ queued }`: the whole queue after the prompt left it.",
      "404": missingItemResponse,
    },
  },
] as const satisfies readonly RouteSpec[];

export const queueFamily = {
  routes: queueRoutes,
  handlers: ({ host }) => ({
    moveQueuedPrompt: async (request, { id, itemId }) => {
      const to = fieldsOf<{ to: unknown }>(await bodyOf(request))?.to;
      if (typeof to !== "number" || !Number.isInteger(to) || to < 0) {
        return json(400, { error: "the body must be { to: a non-negative integer }" });
      }
      const outcome = await host.queue.move(id ?? "", decodeURIComponent(itemId ?? ""), to);
      return typeof outcome === "string" ? queueRefused(outcome) : json(200, outcome);
    },
    cancelQueuedPrompt: async (_request, { id, itemId }) => {
      const outcome = await host.queue.cancel(id ?? "", decodeURIComponent(itemId ?? ""));
      return typeof outcome === "string" ? queueRefused(outcome) : json(200, outcome);
    },
  }),
} satisfies RouteFamily<typeof queueRoutes>;

type ItemRefusal = Exclude<QueueRefusal, "missing">;

const itemRefusals: Readonly<Record<ItemRefusal, { status: number; error: string }>> = {
  unknown: { status: 404, error: "no queued prompt has that id" },
  "out-of-range": { status: 409, error: "to is past the end of the queue" },
  "crosses-steer": {
    status: 409,
    error: "steered prompts run before queued ones, and that move would cross one",
  },
};

function queueRefused(outcome: QueueRefusal): Response {
  if (outcome === "missing") return missingSession();
  const { status, error } = itemRefusals[outcome];
  return json(status, { error });
}
