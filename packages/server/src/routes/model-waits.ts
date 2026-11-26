import { servedBy } from "./answers.ts";
import { json, type RouteFamily, type RouteSpec } from "./family.ts";

export const modelWaitReasons = ["busy", "limited"] as const;

export type ModelWaitReason = (typeof modelWaitReasons)[number];

export interface ModelWait {
  session: string;
  creature: string | null;
  server: string | null;
  reason: ModelWaitReason;
  since: string;
}

export type ModelWaitChangeKind = "waiting" | "over";

export interface ModelWaitChange {
  change: ModelWaitChangeKind;
  wait: ModelWait;
}

export interface ModelWaitsPort {
  list(): ModelWait[];
  subscribe(listener: (change: ModelWaitChange) => void): () => void;
}

export const modelWaitRoutes = [
  {
    method: "GET",
    path: "/model-waits",
    operationId: "listModelWaits",
    summary:
      "The turns waiting on a model that is not answering yet, oldest first: `{ waits }`, each `{ session, creature, server, reason, since }`. Only waits the engine already observes are reported: a turn whose model request failed and that is waiting to try again, `limited` when the provider said it is rate limited (429) and `busy` when it said it is overloaded or timed out (408, or 500 and above). A provider that cannot be reached is not a busy model and is not reported, and the engine keeps no queue of its own for this. `creature` is the creature whose work waits (a sub-agent's wait is its creature's), or null; `server` is the origin of the local model server it waits on, as `GET /models` gives a server's `root`, or null for a cloud provider; `since` is when the wait began. A wait shorter than two seconds is never reported: `model.wait` fires `waiting` once a wait has lasted two seconds, carrying the session's id, and `over` when that turn's model answers, the turn ends, or it waits no longer. Nothing carries a retry time or an attempt, so nothing can count down. For display only. Since contract 1.40.",
    authenticated: true,
    responses: {
      "200": "`{ waits }`, oldest first.",
      "503": "This host reports no waits on a model.",
    },
  },
] as const satisfies readonly RouteSpec[];

export const modelWaitFamily = {
  routes: modelWaitRoutes,
  handlers: ({ host, log, streams }) => {
    if (host.modelWaits !== undefined) {
      streams.add(
        host.modelWaits.subscribe((change) =>
          log.record(change.wait.session, "model.wait", change),
        ),
      );
    }
    const waits = servedBy((): ModelWaitsPort | undefined => host.modelWaits, "waits on a model");
    return {
      listModelWaits: waits(async (port) => json(200, { waits: port.list() })),
    };
  },
} satisfies RouteFamily<typeof modelWaitRoutes>;
