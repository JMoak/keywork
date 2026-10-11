import {
  ArcNotActiveError,
  IneligibleDeliveryError,
  InvalidDailyDateError,
  LedgerEntryNotFoundError,
  MemoryInertError,
  MissingArcError,
  MissingSuccessorError,
  StagedItemNotFoundError,
} from "@keywork/engine";
import type { CandidateChoice, MemoryHost, QuestionChoice } from "../host.ts";
import {
  bodyOf,
  fieldsOf,
  type JsonSchema,
  json,
  nonBlank,
  type RouteFamily,
  type RouteSpec,
} from "./family.ts";

export const maxAskQueryLength = 2000;

const candidateChoices: readonly CandidateChoice[] = ["deliver", "leave"];
const questionChoices: readonly QuestionChoice[] = ["resolve", "carry", "drop"];

const inertNote =
  "When the workspace is untrusted (or has no vault) every read answers `trusted: false` with empty lists and every write answers 403 `memory is inert`.";

const askBody: JsonSchema = {
  type: "object",
  required: ["query"],
  properties: {
    query: { type: "string", minLength: 1, maxLength: maxAskQueryLength },
    arc: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
};

const candidateBody: JsonSchema = {
  type: "object",
  required: ["choice"],
  properties: { choice: { type: "string", enum: [...candidateChoices] } },
  additionalProperties: false,
};

const questionBody: JsonSchema = {
  type: "object",
  required: ["title", "choice"],
  properties: {
    title: { type: "string", minLength: 1 },
    choice: { type: "string", enum: [...questionChoices] },
  },
  additionalProperties: false,
};

const finishBody: JsonSchema = {
  type: "object",
  properties: { force: { type: "boolean" } },
  additionalProperties: false,
};

export const memoryRoutes = [
  {
    method: "GET",
    path: "/memory",
    operationId: "readMemory",
    summary: `The memory garden at a glance: one entry per layer (the workspace vault and each active arc) with its note count, curing tally and, for the workspace, the prompt budget the bootstrap used; the review inbox as the engine's own staged items; this process's write ledger; the curation audit; the gardener's last sweep; and every arc whose close is waiting at the airlock. ${inertNote}`,
    authenticated: true,
    responses: { "200": "The garden." },
  },
  {
    method: "GET",
    path: "/memory/inbox",
    operationId: "readMemoryInbox",
    summary:
      "The review inbox: every staged item waiting for a human, in the engine's own shape (an untrusted write, a borderline promotion, a contradiction, a proposal, an arc review, and whatever kinds the engine adds later), plus the items a bot layer staged, each tagged with its `bot`. `count` is what the `memory.inbox` event carries.",
    authenticated: true,
    responses: { "200": "The inbox and its count." },
  },
  {
    method: "POST",
    path: "/memory/inbox/{id}/approve",
    operationId: "approveStagedItem",
    summary:
      "Approve a staged item: an untrusted write lands in the vault, a proposal is carried out, a bot item lands in its bot layer. Answers the engine's write result (`null` for a bot item) and fires `memory.inbox` with the new count.",
    authenticated: true,
    responses: {
      "200": "The item was approved.",
      "403": "Memory is inert: the workspace is untrusted.",
      "404": "No staged item has that id.",
    },
  },
  {
    method: "POST",
    path: "/memory/inbox/{id}/discard",
    operationId: "discardStagedItem",
    summary: "Discard a staged item without applying it. Fires `memory.inbox` with the new count.",
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
      "Every note the garden holds, each the engine's record plus its `layer` (`workspace` or `arc:<slug>`), `curing` stage 0 to 3, whether the bootstrap `injected` it into the prompt, how many `recalls` it had since the last sweep, and its graph `relations`. `?layer=` narrows to one layer and answers 404 for a layer that does not exist.",
    authenticated: true,
    responses: { "200": "The notes.", "404": "No layer has that id." },
  },
  {
    method: "GET",
    path: "/memory/notes/{name}",
    operationId: "readMemoryNote",
    summary:
      "One note by name (a title, an alias, or an entity path with its slashes percent-encoded), with frontmatter, body, provenance, curing and relations. `?layer=` reads an arc layer instead of the workspace.",
    authenticated: true,
    responses: { "200": "The note.", "404": "No note has that name in that layer." },
  },
  {
    method: "GET",
    path: "/memory/daily",
    operationId: "listMemoryDailyDates",
    summary: "The dates (YYYY-MM-DD) that have a daily log in the workspace vault.",
    authenticated: true,
    responses: { "200": "The dates." },
  },
  {
    method: "GET",
    path: "/memory/daily/{date}",
    operationId: "readMemoryDaily",
    summary: "The daily log for one date: each entry's time, provenance and text.",
    authenticated: true,
    responses: { "200": "The entries.", "400": "The date is not YYYY-MM-DD." },
  },
  {
    method: "GET",
    path: "/memory/ledger",
    operationId: "readMemoryLedger",
    summary:
      "This process's memory write ledger, newest last: every create, edit, approve, discard and revert with full before and after content, capped at the engine's ledger capacity. Entries from earlier processes are gone; the audit on GET /memory is the durable record.",
    authenticated: true,
    responses: { "200": "The ledger entries." },
  },
  {
    method: "POST",
    path: "/memory/ledger/{id}/revert",
    operationId: "revertMemoryLedgerEntry",
    summary:
      "Revert one ledger entry, restoring the files it changed. `outcome` is `reverted`, or `needs-rebase` when a file no longer matches what the entry wrote (nothing is touched then). Fires `memory.inbox` when the revert changed the inbox.",
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
    summary: `Ask the garden a question: a lexical (or hybrid, when embeddings are configured) search over the workspace notes, layered with the active arc's notes when \`arc\` is given. Answers up to 20 hits with their per-leg ranks. The query is capped at ${maxAskQueryLength} characters.`,
    authenticated: true,
    requestBody: askBody,
    responses: { "200": "The hits.", "400": "The body is not `{ query, arc? }`." },
  },
  {
    method: "GET",
    path: "/arcs/{slug}/airlock",
    operationId: "readArcAirlock",
    summary:
      "The close review staged for an arc: each candidate note with its eligibility and shortfalls, each open question, the choices made so far, the successor arc a carried question goes to, and the last session sweep. 404 when no close is waiting for that arc.",
    authenticated: true,
    responses: { "200": "The digest.", "404": "No close review is staged for that arc." },
  },
  {
    method: "POST",
    path: "/arcs/{slug}/airlock/candidates/{note}",
    operationId: "triageAirlockCandidate",
    summary:
      "Decide a candidate note: `deliver` promotes it into the workspace when the arc closes, `leave` keeps it archived in the arc layer. Answers the updated digest.",
    authenticated: true,
    requestBody: candidateBody,
    responses: {
      "200": "The updated digest.",
      "400": "The body is not `{ choice }`.",
      "403": "Memory is inert: the workspace is untrusted.",
      "404": "No close review is staged for that arc, or it has no such candidate.",
      "409": "The note is below the delivery bar and cannot be delivered.",
    },
  },
  {
    method: "POST",
    path: "/arcs/{slug}/airlock/questions",
    operationId: "triageAirlockQuestion",
    summary:
      "Decide an open question by title: `resolve`, `drop`, or `carry` it into the newest other active arc. Answers the updated digest.",
    authenticated: true,
    requestBody: questionBody,
    responses: {
      "200": "The updated digest.",
      "400": "The body is not `{ title, choice }`.",
      "403": "Memory is inert: the workspace is untrusted.",
      "404": "No close review is staged for that arc, or it has no such question.",
      "409": "Carrying needs another active arc and none exists.",
    },
  },
  {
    method: "POST",
    path: "/arcs/{slug}/airlock/deliver",
    operationId: "deliverAirlockEligible",
    summary: "Mark every eligible candidate `deliver` at once. Answers how many were marked.",
    authenticated: true,
    responses: {
      "200": "The number of candidates marked.",
      "403": "Memory is inert: the workspace is untrusted.",
      "404": "No close review is staged for that arc.",
    },
  },
  {
    method: "POST",
    path: "/arcs/{slug}/airlock/finish",
    operationId: "finishArcAirlock",
    summary:
      "Try to close the arc now: flush every session bound to it, stage its close review when none is staged yet, then deliver the chosen notes and archive the arc once every item has a choice. The outcome is `closed`, `undecided` (naming what still needs a choice; the review is now readable at GET /arcs/{slug}/airlock), or `wedged` (naming sessions that did not flush); `force: true` sweeps past wedged sessions.",
    authenticated: true,
    requestBody: finishBody,
    responses: {
      "200": "The finish outcome.",
      "400": "The body is not `{ force? }`.",
      "403": "Memory is inert: the workspace is untrusted.",
      "404": "No active arc has that slug.",
    },
  },
] as const satisfies readonly RouteSpec[];

export const memoryFamily = {
  routes: memoryRoutes,
  handlers: ({ host }) => {
    const memory = host.memory;
    return {
      readMemory: () => reading(() => memory.garden()),
      readMemoryInbox: () =>
        reading(async () => {
          const items = await memory.inbox();
          return { trusted: await memory.trusted(), items, count: items.length };
        }),
      approveStagedItem: (_request, { id }) =>
        writing(memory, async () => {
          const result = await memory.approve(id ?? "");
          return json(200, { id, result: result ?? null });
        }),
      discardStagedItem: (_request, { id }) =>
        writing(memory, async () => {
          await memory.discard(id ?? "");
          return json(200, { id, discarded: true });
        }),
      listMemoryNotes: (request) =>
        reading(async () => {
          const layer = queryOf(request, "layer");
          const notes = await memory.notes(layer);
          if (notes === undefined) return json(404, { error: "no layer has that id" });
          return { trusted: await memory.trusted(), notes };
        }),
      readMemoryNote: (request, { name }) =>
        reading(async () => {
          const noteName = decoded(name);
          if (noteName === undefined) return json(400, { error: "the note name is not decodable" });
          if (!(await memory.trusted())) return { trusted: false, note: null };
          const note = await memory.note(noteName, queryOf(request, "layer"));
          return note === undefined
            ? json(404, { error: "no note has that name in that layer" })
            : { trusted: true, note };
        }),
      listMemoryDailyDates: () =>
        reading(async () => ({
          trusted: await memory.trusted(),
          dates: await memory.dailyDates(),
        })),
      readMemoryDaily: (_request, { date }) =>
        reading(async () => ({
          trusted: await memory.trusted(),
          date,
          entries: await memory.daily(date ?? ""),
        })),
      readMemoryLedger: () =>
        reading(async () => ({ trusted: await memory.trusted(), entries: await memory.ledger() })),
      revertMemoryLedgerEntry: (_request, { id }) =>
        writing(memory, async () => json(200, { id, outcome: await memory.revert(id ?? "") })),
      askMemory: (request) =>
        reading(async () => {
          const question = questionOf(await bodyOf(request));
          if (question === undefined) {
            return json(400, { error: `the body must be { query: string, arc?: string }` });
          }
          const outcome = await memory.ask(question.query, question.arc);
          return { trusted: await memory.trusted(), ...outcome };
        }),
      readArcAirlock: (_request, { slug }) =>
        reading(async () => {
          if (!(await memory.trusted())) return { trusted: false, digest: null };
          const digest = await memory.airlock.digest(slug ?? "");
          return digest === undefined ? noReview() : { trusted: true, digest };
        }),
      triageAirlockCandidate: (request, { slug, note }) =>
        writing(memory, async () => {
          const choice = candidateChoiceOf(await bodyOf(request));
          if (choice === undefined) return json(400, { error: "the body must be { choice }" });
          const name = decoded(note);
          const digest = await memory.airlock.digest(slug ?? "");
          if (digest === undefined) return noReview();
          if (name === undefined || !digest.candidates.some((candidate) => candidate.note === name))
            return json(404, { error: `arc ${slug} has no candidate named ${name}` });
          await memory.airlock.triageCandidate(slug ?? "", name, choice);
          return json(200, (await memory.airlock.digest(slug ?? "")) ?? digest);
        }),
      triageAirlockQuestion: (request, { slug }) =>
        writing(memory, async () => {
          const decision = questionDecisionOf(await bodyOf(request));
          if (decision === undefined)
            return json(400, { error: "the body must be { title, choice }" });
          const digest = await memory.airlock.digest(slug ?? "");
          if (digest === undefined) return noReview();
          if (!digest.questions.some((question) => question.title === decision.title))
            return json(404, {
              error: `arc ${slug} has no open question titled ${decision.title}`,
            });
          await memory.airlock.triageQuestion(slug ?? "", decision.title, decision.choice);
          return json(200, (await memory.airlock.digest(slug ?? "")) ?? digest);
        }),
      deliverAirlockEligible: (_request, { slug }) =>
        writing(memory, async () => {
          if ((await memory.airlock.digest(slug ?? "")) === undefined) return noReview();
          return json(200, { delivered: await memory.airlock.deliverEligible(slug ?? "") });
        }),
      finishArcAirlock: (request, { slug }) =>
        writing(memory, async () => {
          const force = forceOf(await bodyOf(request));
          if (force === undefined)
            return json(400, { error: "the body must be { force?: boolean }" });
          return json(200, await memory.airlock.finish(slug ?? "", { force }));
        }),
    };
  },
} satisfies RouteFamily<typeof memoryRoutes>;

async function reading(read: () => Promise<unknown>): Promise<Response> {
  try {
    const reply = await read();
    return reply instanceof Response ? reply : json(200, reply);
  } catch (cause) {
    return refusalOf(cause);
  }
}

async function writing(memory: MemoryHost, write: () => Promise<Response>): Promise<Response> {
  try {
    return (await memory.trusted()) ? await write() : inert();
  } catch (cause) {
    return refusalOf(cause);
  }
}

function inert(): Response {
  return json(403, { error: new MemoryInertError().message });
}

function refusalOf(cause: unknown): Response {
  if (cause instanceof MemoryInertError) return json(403, { error: cause.message });
  if (cause instanceof InvalidDailyDateError) return json(400, { error: cause.message });
  if (isMissing(cause)) return json(404, { error: cause.message });
  if (cause instanceof MissingSuccessorError || cause instanceof IneligibleDeliveryError)
    return json(409, { error: cause.message });
  throw cause;
}

function isMissing(cause: unknown): cause is Error {
  return (
    cause instanceof StagedItemNotFoundError ||
    cause instanceof LedgerEntryNotFoundError ||
    cause instanceof MissingArcError ||
    cause instanceof ArcNotActiveError
  );
}

function noReview(): Response {
  return json(404, { error: "no close review is staged for that arc" });
}

function queryOf(request: Request, name: string): string | undefined {
  return nonBlank(new URL(request.url).searchParams.get(name) ?? undefined);
}

function decoded(segment: string | undefined): string | undefined {
  try {
    return nonBlank(decodeURIComponent(segment ?? ""));
  } catch {
    return undefined;
  }
}

function questionOf(body: unknown): { query: string; arc: string | undefined } | undefined {
  const fields = fieldsOf<{ query: unknown; arc: unknown }>(body);
  const query = nonBlank(fields?.query);
  if (query === undefined || query.length > maxAskQueryLength) return undefined;
  if (fields?.arc !== undefined && nonBlank(fields.arc) === undefined) return undefined;
  return { query, arc: nonBlank(fields?.arc) };
}

function candidateChoiceOf(body: unknown): CandidateChoice | undefined {
  const choice = fieldsOf<{ choice: unknown }>(body)?.choice;
  return candidateChoices.find((known) => known === choice);
}

function questionDecisionOf(body: unknown): { title: string; choice: QuestionChoice } | undefined {
  const fields = fieldsOf<{ title: unknown; choice: unknown }>(body);
  const title = nonBlank(fields?.title);
  const choice = questionChoices.find((known) => known === fields?.choice);
  return title === undefined || choice === undefined ? undefined : { title, choice };
}

function forceOf(body: unknown): boolean | undefined {
  if (body === undefined) return false;
  const force = fieldsOf<{ force: unknown }>(body)?.force;
  if (force === undefined) return false;
  return typeof force === "boolean" ? force : undefined;
}
