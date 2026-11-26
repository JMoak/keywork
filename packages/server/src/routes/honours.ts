import type { CreatureHonoursPort } from "@keywork/engine";
import { servedBy } from "./answers.ts";
import { json, type RouteFamily, type RouteSpec } from "./family.ts";

export const honourRoutes = [
  {
    method: "GET",
    path: "/creature-honours",
    operationId: "listCreatureHonours",
    summary:
      "What the creatures of this workspace, and the stead itself, have earned: `{ honours }`, each `{ holder, kind, tier, with, earnedAt, proof }`, ordered by `earnedAt`, oldest first. `holder` is a creature's slug, or null for the stead's own. A creature earns `conversations` (tiers at 10, 100 and 1,000 of its conversations that had a turn), `night` (a turn of its work finished between midnight and five in the morning, this machine's time), `partners` (10 and 100 hand-offs with one partner, both directions together, `with` the partner), `tower` (30 and 300 conversations in one folder of `GET /creature-worksites`, `with` the folder), `standing` (each full year since it was made), `range` (4, 8 and 12 kinds of tool, each used successfully ten times; a kind is a tool's name as called) and `run` (7, 30 and 100 days in a row, this machine's calendar, each with a finished turn of its work). The stead earns `first-creature`, `hamlet` (three creatures at once), `town` (eight), `paved-road` (the first pair to reach 20 hand-offs both ways together, `with` the two slugs joined by `+` in alphabetical order) and `first-tower` (the first `tower` of any creature, `with` the folder). Each tier is its own row; a row is named by `holder`, `kind`, `tier` and `with`. `earnedAt` is when it was truly earned, or, where the engine kept no finer fact (hand-offs and folders counted before contract 1.40), the latest time it is known to have been held by, which `proof` says in words: `proof` is one plain sentence a keeper can check. A sub-agent's work belongs to the creature that delegated it, and a creature's threads in a bound project count exactly as its work here: that project's runtime keeps the facts and this server reads them as it reads that project's worksites. Earned honours are never taken away and never re-earned; the answer carries what was earned and never a count in progress. Honours from before contract 1.40 are counted once from the session journals and the hand-off and worksite tallies at the first start, and fire no event; after that the server keeps them as work happens, saved for the workspace under the node's state. Removing a creature drops its honours; the stead's own stay. A console follows `creature.honours` on the event stream after a cold start. With `?visitor=<workspace>` the answer is instead `{ work }`: the dated facts this server kept of the project threads it ran for the creatures of that workspace (`{ creature, conversations, night, tools, days }`: when each conversation first had a turn, the first turn finished at night or null, the first ten successful uses of each tool by name, and the first finished turn of each day), which the creature's own server merges; it is for that server, not for display. Honours are for display only: they grant, widen and imply nothing about what any creature may do. Since contract 1.40.",
    authenticated: true,
    responses: {
      "200": "`{ honours }`, every honour held; `{ work }` with `?visitor`.",
      "503": "This host keeps no honours.",
    },
  },
] as const satisfies readonly RouteSpec[];

export const honourFamily = {
  routes: honourRoutes,
  handlers: ({ host, log, streams }) => {
    if (host.honours !== undefined) {
      streams.add(host.honours.subscribe((change) => log.record("", "creature.honours", change)));
    }
    const honours = servedBy((): CreatureHonoursPort | undefined => host.honours, "honours");
    return {
      listCreatureHonours: honours(async (port, request) => {
        const visitor = new URL(request.url).searchParams.get("visitor");
        if (visitor !== null) return json(200, { work: await port.visiting(visitor) });
        return json(200, { honours: await port.list() });
      }),
    };
  },
} satisfies RouteFamily<typeof honourRoutes>;
