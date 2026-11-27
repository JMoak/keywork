import type {
  CreatureLedgerPort,
  LedgerConversationOutcome,
  LedgerSeenOutcome,
} from "@keywork/engine";
import { servedBy } from "./answers.ts";
import { json, type RouteFamily, type RouteSpec } from "./family.ts";

export const ledgerRoutes = [
  {
    method: "GET",
    path: "/creatures/{slug}/ledger",
    operationId: "readCreatureLedger",
    summary:
      "The creature's ledger for the keeper's console, its questions for the keeper first and then its tasks: `{ creature, entries, folded }`. Not the keeper ledger behind `GET /creatures/{slug}/report`, nor the memory ledger. Each entry is `{ id, kind, state, title, directory, session, openedAt, closedAt, answer, about, conversation }`: `id` is stable, `title` is plain words, `directory` is the working directory of the session the work lives in (the workspace for a chore held on grants), `session` is that session while it is in the session directory and `null` once it is trashed (it comes back with `POST /trash/{id}/restore`) or when the entry never had one, `closedAt` is `null` while the entry is open, `answer` is `null` except on an answered question, and `conversation` is `null` until a short conversation about the entry is opened (`POST /creatures/{slug}/ledger/{id}/conversation`, since contract 1.38). A question (`kind: \"question\"`) is `waiting`, then `answered`, with `answer` `granted`, `denied` or `lapsed` (nobody answered: the ask timed out or its session or the server closed first, or the chore stopped needing the acceptance some other way). `about: { kind: \"ask\", callId, tool }` is a permission ask on one of the creature's sessions (its conversation, a chore run, a thread, or a sub-agent of one), waiting from when `GET /asks` lists it until it leaves, whether the keeper answered it with `POST /asks/{callId}`, a promoted rule class decided it, or it lapsed; `about: { kind: \"grants\", routineId }` is a chore held on a write or act grant set the keeper has not accepted, waiting while `GET /routines/needs-you` lists its `grants` item and `granted` once the keeper accepts it. A task (`kind: \"task\"`) is `running`, then `finished` (it ended and the keeper has not looked at it yet), then `done` once `POST /creatures/{slug}/ledger/{id}/seen` says the keeper looked; or it is `blocked` instead of `finished` when it failed, timed out, ran over budget or could not deliver. `about: { kind: \"chore\", routineId, runId }` is a chore run, running from its thread's opening to its `routine.finished`; `about: { kind: \"thread\" }` is a thread of kind `thread`, running until its first report reaches the conversation; in a bound project it is what the keeper asked for there, running across the thread's turns until a turn delivers work (`finished`) or fails (`blocked`), so a reply that only asks leaves it running, and a later question in the thread while none runs opens one titled with the words that turn was asked (since contract 1.41). The conversation's own turns are not tasks, and a sub-agent's work belongs to the session that delegated it. Entries come waiting questions first, then running tasks, then closed entries, each group newest first. The server writes each change as it happens and keeps the ledger for the workspace under the node's state, so it outlives a restart and the sessions it names; it is never rebuilt from history and began empty with contract 1.37, except that the grant sets chores are held on are read from the chore journal at every start. A task a stopped server left running is `blocked` when the next one starts, unless a question of its thread still waits through the stop (`carried`, since contract 1.41), when it stays `running` and the answer carries its work on. Each creature keeps its 50 most recent closed entries; older ones leave the list and `folded` counts them. Open entries are always kept. Removing a creature (`DELETE /creatures/{slug}?confirmed=true`) drops its ledger, so a creature made again under the same slug starts from none. A console follows `creature.ledger` on the event stream after a cold start. The ledger is a record for display: it grants, widens and implies nothing about what any creature may do, and a question is answered only where it was asked, never here. `project` is null for work on this server; work in a bound project runs in that project's own runtime, which keeps its questions and tasks for the creature by the same rules, and this server reads them from it as it reads that project's worksites (at start, as soon as that runtime says something changed there with `POST /creature-projects/{project}/changed`, however the turn began, and once a second while a thread there works) and carries them with `project` set to the project's id (as in `GET /creatures/{slug}/projects`, since contract 1.40): such a question is answered on that project's server, with `POST /asks/{callId}` there, and its entry follows within about a second; an entry of a project is not settled when this server restarts, since its work did not stop with it. With `?visitor=<workspace>` the answer is instead the entries this server keeps of the project threads it ran for that workspace's creature, for that creature's own server and not for display. Since contract 1.37.",
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
  {
    method: "POST",
    path: "/creatures/{slug}/ledger/{id}/conversation",
    operationId: "openLedgerConversation",
    summary:
      'Open a short conversation with the creature about one entry of its ledger, or return the one already opened: the answer is `{ entry }` with `entry.conversation` set, and asking again for the same entry returns the same conversation, open or ended. The conversation is a fresh session of kind `thread` on this server, titled "About: <entry title>", whose journal names the entry (`GET /sessions/{id}` carries `ledgerEntry: { creature, id }`), framed with the entry so the creature speaks first, on the conversation model of the creature (since contract 1.39; never the model its work threads use). `entry.conversation` is `{ session, state, openedAt, endedAt, endedBy }`: `state` is `open` or `ended`, and `endedBy` is `answer` when the question of the entry was answered (granted, denied or lapsed) or `keeper` when the keeper closed it with `POST /creatures/{slug}/ledger/{id}/conversation/close`. An ended conversation is read-only: `POST /sessions/{id}/prompt` and `/inject` answer 409, `GET /sessions/{id}` still reads it with `endedAt`, the entry keeps pointing at it, and it is no longer among the live `threads` of the creature. When it ends, one line saying what was decided goes into the main conversation of the creature as a creature report. `creature.ledger` fires with `change: "changed"` when it opens and when it ends. It is for work on this server only, so an entry whose `project` is set is refused, answers no question and grants nothing: a permission question is answered with `POST /asks/{callId}` as before. Since contract 1.38.',
    authenticated: true,
    responses: {
      "200": "`{ entry }`, with `entry.conversation` set.",
      "404": "No creature has that slug, or its ledger holds no entry with that id.",
      "409":
        "The entry is a question already answered, and no conversation was opened about it, or its work runs in a bound project's runtime.",
      "503": "This host keeps no creature ledger, or opens no conversations about it.",
    },
  },
  {
    method: "POST",
    path: "/creatures/{slug}/ledger/{id}/conversation/close",
    operationId: "closeLedgerConversation",
    summary:
      'The keeper closes the conversation about a ledger entry: it ends as `POST /creatures/{slug}/ledger/{id}/conversation` describes, with `endedBy: "keeper"`, a running turn is stopped, and the answer is `{ entry }`. Closing an ended conversation answers as it is. It answers no question and grants nothing. Since contract 1.38.',
    authenticated: true,
    responses: {
      "200": "`{ entry }`, its conversation ended.",
      "404":
        "No creature has that slug, its ledger holds no entry with that id, or no conversation was opened about it.",
      "503": "This host keeps no creature ledger, or opens no conversations about it.",
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
      readCreatureLedger: ledger(async (port, request, { slug }) => {
        const visitor = new URL(request.url).searchParams.get("visitor");
        if (visitor !== null && port.visiting !== undefined)
          return json(200, await port.visiting(visitor, slug ?? ""));
        const view = await port.read(slug ?? "");
        return view === undefined ? json(404, { error: missingCreature }) : json(200, view);
      }),
      markCreatureLedgerEntrySeen: ledger(async (port, _request, { slug, id }) => {
        const outcome = await port.seen(slug ?? "", id ?? "");
        return typeof outcome === "string" ? seenRefusal(outcome) : json(200, { entry: outcome });
      }),
      openLedgerConversation: ledger(async (port, _request, { slug, id }) => {
        if (port.converse === undefined) return noConversations();
        return conversationAnswer(await port.converse(slug ?? "", id ?? ""));
      }),
      closeLedgerConversation: ledger(async (port, _request, { slug, id }) => {
        if (port.closeConversation === undefined) return noConversations();
        return conversationAnswer(await port.closeConversation(slug ?? "", id ?? ""));
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

type ConversationRefusal = Extract<LedgerConversationOutcome, string>;

const conversationRefusals: Record<ConversationRefusal, { status: number; error: string }> = {
  "missing-creature": seenRefusals["missing-creature"],
  "missing-entry": seenRefusals["missing-entry"],
  "already-answered": {
    status: 409,
    error: "that question is already answered, so there is nothing left to talk through",
  },
  "no-conversation": { status: 404, error: "no conversation was opened about that entry" },
  "in-a-project": {
    status: 409,
    error:
      "that entry's work runs in a bound project's runtime, and a conversation about it can only be opened on the server where the work runs",
  },
};

function conversationAnswer(outcome: LedgerConversationOutcome): Response {
  if (typeof outcome !== "string") return json(200, { entry: outcome });
  const { status, error } = conversationRefusals[outcome];
  return json(status, { error });
}

function noConversations(): Response {
  return json(503, { error: "this host opens no conversations about its ledger" });
}

function seenRefusal(outcome: SeenRefusal): Response {
  const { status, error } = seenRefusals[outcome];
  return json(status, { error });
}
