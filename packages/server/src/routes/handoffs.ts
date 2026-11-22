import type { CreatureHandoffsPort } from "@keywork/engine";
import { servedBy } from "./answers.ts";
import { json, type RouteFamily, type RouteSpec } from "./family.ts";

export const handoffRoutes = [
  {
    method: "GET",
    path: "/creature-handoffs",
    operationId: "listCreatureHandoffs",
    summary:
      "How often each creature in this workspace has handed work to another: `{ handoffs }`, one row per ordered pair that has at least one, each `{ from, to, count, lastAt }`, ordered by `from` then `to`. A hand-off is a creature message (the `message` tool, or `POST /mesh/messages`) from one creature in this workspace to another on this machine that was delivered into the receiver's conversation; a message refused for its shape, the receiver's inbound policy, a missing receiver or conversation, a repeat or the hourly limits is not one, nor is a message to or from a creature on another machine, a creature's message to itself, an agent's `ask` over MCP, or a thread reporting back to its own creature. `from` and `to` are creature slugs and the two directions are separate rows: `count` is how many hand-offs went from `from` to `to`, and `lastAt` when the latest of them was delivered (ISO 8601). The server counts each hand-off as it is delivered and keeps the tally for the workspace under the node's state, saved on every change, so it outlives a restart; it is never rebuilt from history, and it began empty for hand-offs made before contract 1.36. Removing a creature (`DELETE /creatures/{slug}?confirmed=true`) drops every row that names it, so a creature made again under the same slug starts from none. A console follows `creature.handoff` on the event stream after a cold start. The tally is a count for display only: it grants, widens and implies nothing about what any creature may do. Since contract 1.36.",
    authenticated: true,
    responses: {
      "200": "`{ handoffs }`, every counted pair.",
      "503": "This host keeps no hand-off tally.",
    },
  },
] as const satisfies readonly RouteSpec[];

export const handoffFamily = {
  routes: handoffRoutes,
  handlers: ({ host, log, streams }) => {
    if (host.handoffs !== undefined) {
      streams.add(host.handoffs.subscribe((change) => log.record("", "creature.handoff", change)));
    }
    const handoffs = servedBy((): CreatureHandoffsPort | undefined => host.handoffs, "hand-offs");
    return {
      listCreatureHandoffs: handoffs(async (port) => json(200, { handoffs: port.list() })),
    };
  },
} satisfies RouteFamily<typeof handoffRoutes>;
