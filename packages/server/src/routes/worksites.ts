import type { CreatureWorksitesPort } from "@keywork/engine";
import { servedBy } from "./answers.ts";
import { json, type RouteFamily, type RouteSpec } from "./family.ts";

export const worksiteRoutes = [
  {
    method: "GET",
    path: "/creature-worksites",
    operationId: "listCreatureWorksites",
    summary:
      "The folders each creature in this workspace has worked in: `{ worksites }`, one row per creature and folder, each `{ creature, directory, root, project, conversations, since, latest, active }`, ordered by `creature`, then `since`, then `directory`. `root` is the directory the conversations started in (this workspace, or a bound project's directory) and `directory` the worksite, an absolute path in the form a session reports its `cwd`. When `root` is a repository (it holds `.git`), every conversation there that had a turn counts toward `root` itself, and its folders are never worksites. Otherwise a conversation counts toward each immediate child folder of `root` in which a `write` or `edit` tool call with a `path` succeeded, and toward `root` itself only for a file changed directly in it. A file changed outside `root` counts toward the nearest folder above it that holds `.git`, as a row whose `root` is that folder, and toward nothing when there is none. Reading, searching, talking and commands count toward nothing, since no command's working directory is recorded, and `.keywork` is never a worksite. A sub-agent's work belongs to the conversation that delegated it. A bound project's threads run in that project's own runtime, which counts them by the same rule for the creature; this server reads those rows from it when it starts, after it starts a thread there, and once a second while one of its threads there is working, and carries them with `project` set to the project's id and `root` to the project's directory. `conversations` is how many of the creature's conversations worked there, `since` and `latest` the first and the latest work there (ISO 8601), and `active` whether a turn is running now in a conversation that has worked there. On Windows two spellings of one folder are one row. Conversations from before contract 1.39 are counted once from the session journals at the first start; after that the server counts work as it happens and keeps the tally for the workspace under the node's state, saved as rows change, so it outlives a restart without reading the journals again. Rows only grow; removing a creature (`DELETE /creatures/{slug}?confirmed=true`) drops its rows. A console follows `creature.worksites` on the event stream after a cold start. With `?visitor=<workspace>` the answer is instead `{ worksites, working }`: the rows of the project threads this server ran for the creatures of that workspace (the identity a creature project request names), with `creature` their slug there, and `working` how many of those threads have a turn running; it is what the creature's own server reads. The tally is for display only: it grants, widens and implies nothing about what any creature may do. Since contract 1.39.",
    authenticated: true,
    responses: {
      "200": "`{ worksites }`, every counted worksite; `{ worksites, working }` with `?visitor`.",
      "503": "This host keeps no worksite tally.",
    },
  },
] as const satisfies readonly RouteSpec[];

export const worksiteFamily = {
  routes: worksiteRoutes,
  handlers: ({ host, log, streams }) => {
    if (host.worksites !== undefined) {
      streams.add(
        host.worksites.subscribe((change) => log.record("", "creature.worksites", change)),
      );
    }
    const worksites = servedBy(
      (): CreatureWorksitesPort | undefined => host.worksites,
      "worksites",
    );
    return {
      listCreatureWorksites: worksites(async (port, request) => {
        const visitor = new URL(request.url).searchParams.get("visitor");
        if (visitor !== null) return json(200, await port.visiting(visitor));
        return json(200, { worksites: await port.list() });
      }),
    };
  },
} satisfies RouteFamily<typeof worksiteRoutes>;
