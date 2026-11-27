import type { CreatureDeliveriesPort } from "@keywork/engine";
import { servedBy } from "./answers.ts";
import { json, type RouteFamily, type RouteSpec } from "./family.ts";

export const deliveryRoutes = [
  {
    method: "GET",
    path: "/creature-deliveries",
    operationId: "listCreatureDeliveries",
    summary:
      "The storehouse: what the creatures of this workspace delivered, newest first, `{ deliveries, folded }`. A delivery is `{ id, creature, line, title, files, at, directory, session, project, about, openedAt }`: `line` is the one report line of the work (the creature's first sentence, or the files it changed when it said nothing), `title` is the thread's or chore's title and null for the creature's own conversation, `files` is `{ path, added, deleted }` for each file the delivering turn changed, relative to `directory`, `at` is when it was delivered, `session` is the conversation it came from (null once that conversation is trashed; it comes back with `POST /trash/{id}/restore`), `project` is the bound project's id when the work ran in that project's runtime and null here, `about` is `{ kind: conversation }` (a finished turn of the creature's own conversation), `{ kind: thread }` (the finish of a thread it sent away to do work, or a later turn of a thread that changed files, here or in a bound project) or `{ kind: chore, routineId, runId }` (a chore run that delivered), and `openedAt` is null until the keeper opens it (`POST /creature-deliveries/{id}/opened`). The storehouse holds work, and a plain reply stays in the conversation, at home or in a project: a finished turn delivers when it changed files (where the server keeps no checkpoints, or the creature's workshop works on a copy of the workspace, when it ran a tool that writes), in the creature's own conversation and in every thread, here or in a bound project; a thread of its own it sent away to do work also delivers when it first finishes; a chore run delivers only when its run row says `delivered`; and a turn that failed or was interrupted delivers nothing. A turn that carries on a turn the engine stopped in (its question answered after the stop) lists every file both changed (since contract 1.41). Each such turn's `turn.completed` carries `delivery`, the id of the delivery it made or null, and comes after the delivery's `creature.deliveries`. Each creature keeps its 50 latest deliveries; older ones leave the list and `folded[slug]` counts them, a count that only grows while the creature stands (a creature with none folded is absent from `folded`). The server writes each delivery as it happens and keeps them for the workspace under the node's state, so they and whether each was opened outlive a restart; it began empty with contract 1.41 and is never rebuilt from history. Work in a bound project counts exactly as work here: that project's runtime keeps its deliveries for the creature, and this server reads them as it reads that project's ledger and carries them with `project` set. Removing a creature drops its deliveries. A console follows `creature.deliveries` on the event stream after a cold start. With `?visitor=<workspace>` the answer is instead `{ deliveries }`, what this server kept of the project threads it ran for that workspace's creatures, for that creature's own server and not for display. Deliveries are a record for display: they grant, widen and imply nothing. Since contract 1.41.",
    authenticated: true,
    responses: {
      "200": "`{ deliveries, folded }`; `{ deliveries }` with `?visitor`.",
      "503": "This host keeps no storehouse.",
    },
  },
  {
    method: "POST",
    path: "/creature-deliveries/{id}/opened",
    operationId: "openCreatureDelivery",
    summary:
      'The keeper has opened a delivery: `openedAt` is set, the answer is `{ delivery }` and `creature.deliveries` fires with `change: "opened"`. A delivery already opened answers as it is and fires nothing. It grants nothing. Since contract 1.41.',
    authenticated: true,
    responses: {
      "200": "`{ delivery }`, now opened.",
      "404": "The storehouse holds no delivery with that id.",
      "503": "This host keeps no storehouse.",
    },
  },
] as const satisfies readonly RouteSpec[];

export const deliveryFamily = {
  routes: deliveryRoutes,
  handlers: ({ host, log, streams }) => {
    if (host.deliveries !== undefined) {
      streams.add(
        host.deliveries.subscribe((change) => log.record("", "creature.deliveries", change)),
      );
    }
    const deliveries = servedBy(
      (): CreatureDeliveriesPort | undefined => host.deliveries,
      "the storehouse",
    );
    return {
      listCreatureDeliveries: deliveries(async (port, request) => {
        const visitor = new URL(request.url).searchParams.get("visitor");
        if (visitor !== null && port.visiting !== undefined)
          return json(200, { deliveries: await port.visiting(visitor) });
        return json(200, await port.list());
      }),
      openCreatureDelivery: deliveries(async (port, _request, { id }) => {
        const delivery = await port.opened(id ?? "");
        return delivery === undefined
          ? json(404, { error: "the storehouse holds no delivery with that id" })
          : json(200, { delivery });
      }),
    };
  },
} satisfies RouteFamily<typeof deliveryRoutes>;
