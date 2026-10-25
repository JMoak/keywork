import {
  IneligibleDeliveryError,
  isStagedWrite,
  LedgerEntryNotFoundError,
  MemoryInertError,
  MissingSuccessorError,
  type Note,
  type StagedItem,
  StagedItemNotFoundError,
} from "@keywork/engine";
import type { MemoryPort } from "../host.ts";
import {
  bodyOf,
  fieldsOf,
  type JsonSchema,
  json,
  nonBlank,
  type RouteContext,
  type RouteFamily,
  type RouteHandler,
  type RouteSpec,
} from "./family.ts";

const askBody: JsonSchema = {
  type: "object",
  required: ["query"],
  properties: { query: { type: "string", minLength: 1 }, arc: { type: "string" } },
  additionalProperties: false,
};

export const memoryRoutes = [
  {
    method: "GET",
    path: "/memory",
    operationId: "readMemory",
    summary:
      "The whole memory vault at a glance: the layers notes live in (`workspace`, one `arc:<slug>` per active arc), the review inbox as raw staged items, this process's mutation ledger, the vault's curation audit, the gardener's last sweep and every arc waiting at the airlock. `trusted: false` means the workspace is untrusted and memory is inert: every list is empty and every write answers 403.",
    authenticated: true,
    responses: { "200": "The overview, or the inert shape when the workspace is untrusted." },
  },
  {
    method: "GET",
    path: "/memory/inbox",
    operationId: "listMemoryInbox",
    summary:
      "Items waiting for a person: untrusted writes held in staging and the gardener's review proposals, each as the engine's `StagedItem` with its `kind`. `count` is the number the `memory.inbox` event carries.",
    authenticated: true,
    responses: { "200": "The staged items and their count." },
  },
  {
    method: "POST",
    path: "/memory/inbox/{id}/approve",
    operationId: "approveStagedItem",
    summary:
      "Land a staged item: a staged write moves to its target note, daily log or map; a proposal is applied. Fires `memory.inbox` with the new count. The answer is the engine's `WriteResult` (`path`, `staged`, `ledgerId`) when the workspace store landed it, or `{}` when a bot's own store did.",
    authenticated: true,
    responses: {
      "200": "The item landed.",
      "403": "Memory is inert: the workspace is untrusted.",
      "404": "No staged item has that id.",
    },
  },
  {
    method: "POST",
    path: "/memory/inbox/{id}/discard",
    operationId: "discardStagedItem",
    summary: "Drop a staged item without landing it. Fires `memory.inbox` with the new count.",
    authenticated: true,
    responses: {
      "200": "The item was discarded.",
      "403": "Memory is inert: the workspace is untrusted.",
      "404": "No staged item has that id.",
    },
  },
  {
    method: "GET",
    path: "/memory/notes",
    operationId: "listMemoryNotes",
    summary:
      "Every note the agent can recall, as the engine's `Note` plus the layer it lives in, its file on disk, whether the bootstrap injects it into the system prompt, how often it was recalled since the last sweep and its curing stage (0 raw, 1 has a confidence, 2 has proved useful, 3 settled). `?layer=<id>` keeps one layer.",
    authenticated: true,
    responses: { "200": "The notes." },
  },
  {
    method: "GET",
    path: "/memory/notes/{name}",
    operationId: "readMemoryNote",
    summary:
      "One note by name (URL-encode it; entity notes are named by path, such as `entities/src/app.ts`), with its graph relations: each `{ name, predicate, direction }` edge the note takes part in. `?layer=<id>` reads it from that layer only, for a name an arc layer shares with the workspace; without it the first layer that holds the name answers, workspace first.",
    authenticated: true,
    responses: { "200": "The note.", "404": "No note has that name." },
  },
  {
    method: "GET",
    path: "/memory/daily",
    operationId: "listMemoryDailyDates",
    summary: "The dates (`YYYY-MM-DD`) that have a daily log.",
    authenticated: true,
    responses: { "200": "The dates." },
  },
  {
    method: "GET",
    path: "/memory/daily/{date}",
    operationId: "readMemoryDaily",
    summary:
      "One day's episodic log: each entry's time, provenance class, text and the session that wrote it when known.",
    authenticated: true,
    responses: { "200": "The entries.", "400": "The date is not `YYYY-MM-DD`." },
  },
  {
    method: "GET",
    path: "/memory/ledger",
    operationId: "readMemoryLedger",
    summary:
      "This server process's memory mutations, oldest first, capped at 128: each entry's op, time and file deltas with before and after content and hashes. Any entry can be reverted.",
    authenticated: true,
    responses: { "200": "The ledger entries." },
  },
  {
    method: "POST",
    path: "/memory/ledger/{id}/revert",
    operationId: "revertMemoryLedgerEntry",
    summary:
      "Undo one ledger entry. `outcome` is `reverted` when every file still matched the entry's recorded result, or `needs-rebase` when something edited a file since; a rebase touches nothing.",
    authenticated: true,
    responses: {
      "200": "The revert outcome.",
      "403": "Memory is inert: the workspace is untrusted.",
      "404": "No ledger entry has that id.",
    },
  },
  {
    method: "POST",
    path: "/memory/ask",
    operationId: "askMemory",
    summary:
      "Search memory the way the agent's recall does: lexical, semantic and graph legs ranked per hit. With `arc`, that arc's layer is searched on top of the workspace and boosted.",
    authenticated: true,
    requestBody: askBody,
    responses: { "200": "The ranked hits.", "400": "The body is not `{ query, arc? }`." },
  },
] as const satisfies readonly RouteSpec[];

export const memoryFamily = {
  routes: memoryRoutes,
  handlers: (context) => {
    const memory = memoryGate(context);
    return {
      readMemory: memory.read(async (port) => port.overview(), {
        layers: [],
        inbox: [],
        ledger: [],
        audit: [],
        airlocks: [],
      }),
      listMemoryInbox: memory.read(
        async (port) => {
          const items = await port.inbox();
          return { items, count: items.length };
        },
        { items: [], count: 0 },
      ),
      approveStagedItem: memory.write(async (port, { id }) => {
        const result = await port.approve(decodeURIComponent(id ?? ""));
        return result ?? {};
      }),
      discardStagedItem: memory.write(async (port, { id }) => {
        await port.discard(decodeURIComponent(id ?? ""));
        return {};
      }),
      listMemoryNotes: memory.read(
        async (port, request) => {
          const layer = new URL(request.url).searchParams.get("layer");
          const notes = (await port.notes()).filter(
            (note) => layer === null || note.layer === layer,
          );
          return { notes: notes.map(withCuring) };
        },
        { notes: [] },
      ),
      readMemoryNote: memory.read(async (port, request, { name }) => {
        const layer = new URL(request.url).searchParams.get("layer") ?? undefined;
        const note = await port.note(decodeURIComponent(name ?? ""), layer);
        return note === undefined
          ? json(404, { error: `no note named ${JSON.stringify(name)}` })
          : withCuring(note);
      }, {}),
      listMemoryDailyDates: memory.read(async (port) => ({ dates: await port.dailyDates() }), {
        dates: [],
      }),
      readMemoryDaily: memory.read(
        async (port, _request, { date }) =>
          isDailyDate(date) ? { date, entries: await port.daily(date) } : badDate(date),
        (_request, { date }) => (isDailyDate(date) ? { date, entries: [] } : badDate(date)),
      ),
      readMemoryLedger: memory.read(async (port) => ({ entries: port.ledger() }), {
        entries: [],
      }),
      revertMemoryLedgerEntry: memory.write(async (port, { id }) => ({
        outcome: await port.revert(decodeURIComponent(id ?? "")),
      })),
      askMemory: memory.read(
        async (port, request) => {
          const question = questionOf(await bodyOf(request));
          if (question === undefined) return badAsk();
          return port.query(question.query, question.arc);
        },
        async (request) => {
          const question = questionOf(await bodyOf(request));
          return question === undefined ? badAsk() : { hits: [], source: "lexical" };
        },
      ),
    };
  },
} satisfies RouteFamily<typeof memoryRoutes>;

export type CuringStage = 0 | 1 | 2 | 3;

export function curingStage(note: Note): CuringStage {
  if (note.provenance === "user" || note.pinned) return 3;
  const usefulness = note.usefulness ?? 0;
  if (usefulness >= settledUsefulness) return 3;
  if (usefulness > 0) return 2;
  return note.confidence === undefined ? 0 : 1;
}

export interface InboxTally {
  count: number;
  staged: number;
  airlock: number;
  proposals: number;
  contradictions: number;
}

export function inboxTally(items: readonly StagedItem[]): InboxTally {
  const tally: InboxTally = {
    count: items.length,
    staged: 0,
    airlock: 0,
    proposals: 0,
    contradictions: 0,
  };
  for (const item of items) tally[bucketOf(item)] += 1;
  return tally;
}

type RouteParams = Readonly<Record<string, string>>;

type LiveRead = (port: MemoryPort, request: Request, params: RouteParams) => Promise<unknown>;

type InertShape = object | ((request: Request, params: RouteParams) => unknown);

type Write = (port: MemoryPort, params: RouteParams, request: Request) => Promise<unknown>;

export interface MemoryGate {
  read(live: LiveRead, inert: InertShape): RouteHandler;
  write(act: Write): RouteHandler;
  feed: InboxFeed;
}

export function memoryGate(context: RouteContext): MemoryGate {
  const feed = inboxFeedOf(context);
  const portOf = (): MemoryPort | undefined => context.host.memory;
  return {
    feed,
    read: (live, inert) => async (request, params) => {
      const port = portOf();
      if (port === undefined) return unserved();
      if (!port.trusted())
        return answer({ trusted: false }, await resolveInert(inert, request, params));
      return answer({ trusted: true }, await live(port, request, params));
    },
    write: (act) => async (request, params) => {
      const port = portOf();
      if (port === undefined) return unserved();
      if (!port.trusted()) return inertWrite();
      try {
        const body = await act(port, params, request);
        await feed.publish();
        return body instanceof Response ? body : json(200, body);
      } catch (cause) {
        const refusal = refusalOf(cause);
        if (refusal === undefined) throw cause;
        return refusal;
      }
    },
  };
}

export class InboxFeed {
  private reported: number | undefined;

  constructor(private readonly context: RouteContext) {}

  async publish(): Promise<void> {
    const port = this.context.host.memory;
    if (port === undefined) return;
    this.record(inboxTally(port.trusted() ? await port.inbox() : []));
  }

  async refresh(): Promise<void> {
    const port = this.context.host.memory;
    if (port === undefined) return;
    const tally = inboxTally(port.trusted() ? await port.inbox() : []);
    if (tally.count !== this.reported) this.record(tally);
  }

  private record(tally: InboxTally): void {
    this.reported = tally.count;
    this.context.log.record("", "memory.inbox", tally);
  }
}

const feeds = new WeakMap<RouteContext, InboxFeed>();

function inboxFeedOf(context: RouteContext): InboxFeed {
  const existing = feeds.get(context);
  if (existing !== undefined) return existing;
  const feed = new InboxFeed(context);
  feeds.set(context, feed);
  const stop = context.host.memory?.subscribe?.(() => void feed.refresh().catch(() => undefined));
  if (stop !== undefined) context.streams.add(stop);
  return feed;
}

const settledUsefulness = 0.5;

function bucketOf(item: StagedItem): Exclude<keyof InboxTally, "count"> {
  if (isStagedWrite(item)) return "staged";
  if (item.kind === "arc-distillation" || item.kind === "arc-question") return "airlock";
  if (item.kind === "contradiction") return "contradictions";
  return "proposals";
}

function withCuring<Shape extends Note>(note: Shape): Shape & { curing: CuringStage } {
  return { ...note, curing: curingStage(note) };
}

async function resolveInert(inert: InertShape, request: Request, params: RouteParams) {
  return typeof inert === "function" ? inert(request, params) : inert;
}

function answer(mark: { trusted: boolean }, body: unknown): Response {
  if (body instanceof Response) return body;
  return json(200, { ...mark, ...(body as object) });
}

function unserved(): Response {
  return json(503, { error: "memory is not served by this host" });
}

function inertWrite(): Response {
  return json(403, { error: new MemoryInertError().message });
}

function refusalOf(cause: unknown): Response | undefined {
  if (cause instanceof MemoryInertError) return json(403, { error: cause.message });
  if (cause instanceof StagedItemNotFoundError) return json(404, { error: cause.message });
  if (cause instanceof LedgerEntryNotFoundError) return json(404, { error: cause.message });
  if (cause instanceof MissingSuccessorError) return json(409, { error: cause.message });
  if (cause instanceof IneligibleDeliveryError) return json(409, { error: cause.message });
  return undefined;
}

function questionOf(body: unknown): { query: string; arc: string | undefined } | undefined {
  const fields = fieldsOf<{ query: unknown; arc: unknown }>(body);
  const query = nonBlank(fields?.query);
  if (query === undefined) return undefined;
  const arc = fields?.arc;
  if (arc !== undefined && typeof arc !== "string") return undefined;
  return { query, arc };
}

const dailyDatePattern = /^\d{4}-\d{2}-\d{2}$/;

function isDailyDate(date: string | undefined): date is string {
  return date !== undefined && dailyDatePattern.test(date);
}

function badDate(date: string | undefined): Response {
  return json(400, {
    error: `invalid daily log date ${JSON.stringify(date)}: expected YYYY-MM-DD`,
  });
}

function badAsk(): Response {
  return json(400, { error: "the body must be { query: string, arc?: string }" });
}
