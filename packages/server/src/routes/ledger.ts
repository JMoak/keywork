import type { CreatureLedgerPort, LedgerSeenOutcome } from "@keywork/engine";
import { servedBy } from "./answers.ts";
import { json, type RouteFamily, type RouteSpec } from "./family.ts";

export const ledgerRoutes = [
  {
    method: "GET",
    path: "/creatures/{slug}/ledger",
    operationId: "readCreatureLedger",
    summary:
      'The creature\'s ledger for the keeper\'s console, its questions for the keeper first and then its tasks: `{ creature, entries, folded }`. Not the keeper ledger behind `GET /creatures/{slug}/report`, nor the memory ledger. Each entry is `{ id, kind, state, title, directory, session, openedAt, closedAt, answer, about }`: `id` is stable, `title` is plain words, `directory` is the working directory of the session the work lives in (the workspace for a chore held on grants), `session` is that session while it is in the session directory and `null` once it is trashed (it comes back with `POST /trash/{id}/restore`) or when the entry never had one, `closedAt` is `null` while the entry is open, and `answer` is `null` except on an answered question. A question (`kind: "question"`) is `waiting`, then `answered`, with `answer` `granted`, `denied` or `lapsed` (nobody answered: the ask timed out or its session or the server closed first, or the chore stopped needing the acceptance some other way). `about: { kind: "ask", callId, tool }` is a permission ask on one of the creature\'s sessions (its conversation, a chore run, a thread, or a sub-agent of one), waiting from when `GET /asks` lists it until it leaves, whether the keeper answered it with `POST /asks/{callId}`, a promoted rule class decided it, or it lapsed; `about: { kind: "grants", routineId }` is a chore held on a write or act grant set the keeper has not accepted, waiting while `GET /routines/needs-you` lists its `grants` item and `granted` once the keeper accepts it. A task (`kind: "task"`) is `running`, then `finished` (it ended and the keeper has not looked at it yet), then `done` once `POST /creatures/{slug}/ledger/{id}/seen` says the keeper looked; or it is `blocked` instead of `finished` when it failed, timed out, ran over budget or could not deliver. `about: { kind: "chore", routineId, runId }` is a chore run, running from its thread\'s opening to its `routine.finished`; `about: { kind: "thread" }` is a thread of kind `thread`, running until its first report reaches the conversation. The conversation\'s own turns are not tasks, and a sub-agent\'s work belongs to the session that delegated it. Entries come waiting questions first, then running tasks, then closed entries, each group newest first. The server writes each change as it happens and keeps the ledger for the workspace under the node\'s state, so it outlives a restart and the sessions it names; it is never rebuilt from history and began empty with contract 1.37, except that the grant sets chores are held on are read from the chore journal at every start. No ask or turn outlives the server, so an ask a stopped server left waiting is `answered` as `lapsed` and a task it left running is `blocked` when the next one starts. Each creature keeps its 50 most recent closed entries; older ones leave the list and `folded` counts them. Open entries are always kept. Removing a creature (`DELETE /creatures/{slug}?confirmed=true`) drops its ledger, so a creature made again under the same slug starts from none. A console follows `creature.ledger` on the event stream after a cold start. The ledger is a record for display: it grants, widens and implies nothing about what any creature may do, and a question is answered only where it was asked, never here. Since contract 1.37.',
    authenticated: true,
    responses: {
      "200": "`{ creature, entries, folded }`.",
      "404": "No creature has that slug.",
      "503": "This host keeps no creature ledger.",
    },
  },
  {
    method: "POST",
    path: "/creatures/{slug}/ledger/{id}/seen",
    operationId: "markCreatureLedgerEntrySeen",
    summary:
      'The keeper has looked at a finished task: its `state` moves from `finished` to `done`, the answer is `{ entry }` and `creature.ledger` fires with `change: "changed"`. A task already `done` answers as it is and fires nothing. A question, or a task still running or blocked, is refused. It answers no question and grants nothing. Since contract 1.37.',
    authenticated: true,
    responses: {
      "200": "`{ entry }`, now `done`.",
      "404": "No creature has that slug, or its ledger holds no entry with that id.",
      "409": "The entry is not a finished task.",
      "503": "This host keeps no creature ledger.",
    },
  },
] as const satisfies readonly RouteSpec[];

export const ledgerFamily = {
  routes: ledgerRoutes,
  handlers: ({ host, log, streams }) => {
    if (host.ledger !== undefined) {
      streams.add(host.ledger.subscribe((change) => log.record("", "creature.ledger", change)));
    }
    const ledger = servedBy(
      (): CreatureLedgerPort | undefined => host.ledger,
      "the creature ledger",
    );
    return {
      readCreatureLedger: ledger(async (port, _request, { slug }) => {
        const view = await port.read(slug ?? "");
        return view === undefined ? json(404, { error: missingCreature }) : json(200, view);
      }),
      markCreatureLedgerEntrySeen: ledger(async (port, _request, { slug, id }) => {
        const outcome = await port.seen(slug ?? "", id ?? "");
        return typeof outcome === "string" ? seenRefusal(outcome) : json(200, { entry: outcome });
      }),
    };
  },
} satisfies RouteFamily<typeof ledgerRoutes>;

const missingCreature = "no creature has that slug";

type SeenRefusal = Extract<LedgerSeenOutcome, string>;

const seenRefusals: Record<SeenRefusal, { status: number; error: string }> = {
  "missing-creature": { status: 404, error: missingCreature },
  "missing-entry": { status: 404, error: "the creature's ledger holds no entry with that id" },
  "not-finished": {
    status: 409,
    error: "only a finished task can be marked seen; a question is answered where it was asked",
  },
};

function seenRefusal(outcome: SeenRefusal): Response {
  const { status, error } = seenRefusals[outcome];
  return json(status, { error });
}
