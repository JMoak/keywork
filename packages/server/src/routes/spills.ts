import { answering } from "./answers.ts";
import { json, missingSession, type RouteFamily, type RouteSpec } from "./family.ts";
import { byteRangeOf } from "./files.ts";

export const spillRoutes = [
  {
    method: "GET",
    path: "/sessions/{id}/spills/{spillId}",
    operationId: "readSessionSpill",
    summary:
      "A slice of the full output a tool result clipped, read from the session's own spill directory beside its log and never from the workspace, so the tool jail does not apply and a spill stays readable wherever the workspace scope ends. `spillId` is `spill.id` from the tool result (on `tool.finished` and in the stored message); only a spill this session's log references is served. Without `from` and `to` the slice is exactly the clipped range the reference carries, `[elidedFrom, elidedTo)`; with either, it is the bytes `[from, to)` of the whole output. At most 1 MiB comes back per request: when the slice was cut short, `truncated` is true and `to` says where it stopped. `bytes` is the whole output's size and `spill` the reference itself. A slice holding a NUL byte is refused as binary.",
    authenticated: true,
    responses: {
      "200": "`{ spill, bytes, from, to, text, truncated, encoding }`.",
      "400": "`from` or `to` is not a non-negative integer.",
      "404":
        'No session has that id, or `{ error: "no spill has that id in this session" }`, or the spill file is gone.',
      "415": "The slice holds a NUL byte.",
    },
  },
] as const satisfies readonly RouteSpec[];

export const spillFamily = {
  routes: spillRoutes,
  handlers: ({ host }) => ({
    readSessionSpill: answering(async (request, { id, spillId }) => {
      const range = byteRangeOf(new URL(request.url).searchParams);
      if (range === undefined) {
        return json(400, { error: "from and to must be non-negative integers" });
      }
      const outcome = await host.spill(id ?? "", decodeURIComponent(spillId ?? ""), range);
      if (outcome === "missing") return missingSession();
      if (outcome === "unknown-spill") {
        return json(404, { error: "no spill has that id in this session" });
      }
      return json(200, outcome);
    }),
  }),
} satisfies RouteFamily<typeof spillRoutes>;
