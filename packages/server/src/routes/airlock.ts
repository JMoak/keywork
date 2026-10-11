import type { CandidateTriage, CloseDecisions, QuestionTriage } from "@keywork/engine";
import type { ArcCloseDigestRecord, MemoryPort } from "../host.ts";
import {
  bodyOf,
  fieldsOf,
  type JsonSchema,
  json,
  nonBlank,
  type RouteFamily,
  type RouteSpec,
} from "./family.ts";
import { memoryGate } from "./memory.ts";

const candidateChoices = ["deliver", "leave"] as const;
const questionChoices = ["resolve", "carry", "drop"] as const;

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

export const airlockRoutes = [
  {
    method: "GET",
    path: "/arcs/{slug}/airlock",
    operationId: "readAirlock",
    summary:
      "An arc waiting to close: the notes it distilled (`candidates`, each with whether it meets the delivery bar and why not), its open `questions`, the sweep of its live sessions, the `successor` arc carried questions go to, and `decisions` so far. Every candidate and question needs a choice before the close can finish.",
    authenticated: true,
    responses: {
      "200": "The digest, or the inert shape when the workspace is untrusted.",
      "404": "No review is staged for that arc.",
    },
  },
  {
    method: "POST",
    path: "/arcs/{slug}/airlock/candidates/{note}",
    operationId: "triageAirlockCandidate",
    summary:
      "Decide one distilled note: `deliver` promotes it into workspace memory when the arc closes (refused with 409 when it is below the bar), `leave` keeps it in the arc's archive.",
    authenticated: true,
    requestBody: candidateBody,
    responses: {
      "200": "The digest after the decision.",
      "400": 'The body is not `{ choice: "deliver" | "leave" }`.',
      "403": "Memory is inert: the workspace is untrusted.",
      "404": "No review is staged for that arc, or it has no such candidate.",
      "409": "The note is below the delivery bar.",
    },
  },
  {
    method: "POST",
    path: "/arcs/{slug}/airlock/questions",
    operationId: "triageAirlockQuestion",
    summary:
      "Decide one open question by title: `resolve` closes it, `carry` moves it to the newest other active arc (409 when there is none), `drop` closes it unanswered.",
    authenticated: true,
    requestBody: questionBody,
    responses: {
      "200": "The digest after the decision.",
      "400": 'The body is not `{ title, choice: "resolve" | "carry" | "drop" }`.',
      "403": "Memory is inert: the workspace is untrusted.",
      "404": "No review is staged for that arc, or it has no such question.",
      "409": "No other active arc can carry the question.",
    },
  },
  {
    method: "POST",
    path: "/arcs/{slug}/airlock/deliver",
    operationId: "deliverAirlock",
    summary:
      "Decide every candidate at once: each eligible note is marked `deliver`, each below the bar `leave`. `delivered` counts the notes marked for delivery.",
    authenticated: true,
    responses: {
      "200": "How many candidates will be delivered.",
      "403": "Memory is inert: the workspace is untrusted.",
      "404": "No review is staged for that arc.",
    },
  },
  {
    method: "POST",
    path: "/arcs/{slug}/airlock/finish",
    operationId: "finishAirlock",
    summary:
      "Close the arc with the decisions made so far. `kind` says what happened: `closed` (notes delivered, bound sessions released), `undecided` (`items` still need a choice), `wedged` (`sessions` did not flush their memory; `force: true` closes past them) or `pending`.",
    authenticated: true,
    requestBody: finishBody,
    responses: {
      "200": "The finish outcome.",
      "403": "Memory is inert: the workspace is untrusted.",
      "404": "No review is staged for that arc.",
    },
  },
] as const satisfies readonly RouteSpec[];

export const airlockFamily = {
  routes: airlockRoutes,
  handlers: (context) => {
    const memory = memoryGate(context);
    return {
      readAirlock: memory.read(
        async (port, _request, { slug }) => digestAnswer(port, slug ?? ""),
        (_request, { slug }) => inertDigest(slug ?? ""),
      ),
      triageAirlockCandidate: memory.write(async (port, { slug, note }, request) => {
        const choice = candidateChoiceOf(await bodyOf(request));
        if (choice === undefined) {
          return json(400, { error: 'the body must be { choice: "deliver" | "leave" }' });
        }
        const arc = slug ?? "";
        const name = decodeURIComponent(note ?? "");
        const digest = await port.airlock.digest(arc);
        if (digest === undefined) return noReview(arc);
        if (!digest.candidates.some((candidate) => candidate.note === name)) {
          return json(404, { error: `arc ${arc} has no candidate named ${name}` });
        }
        await port.airlock.triageCandidate(arc, name, choice);
        return digestAnswer(port, arc);
      }),
      triageAirlockQuestion: memory.write(async (port, { slug }, request) => {
        const decision = questionDecisionOf(await bodyOf(request));
        if (decision === undefined) {
          return json(400, {
            error: 'the body must be { title: string, choice: "resolve" | "carry" | "drop" }',
          });
        }
        const arc = slug ?? "";
        const digest = await port.airlock.digest(arc);
        if (digest === undefined) return noReview(arc);
        if (!digest.questions.some((question) => question.title === decision.title)) {
          return json(404, { error: `arc ${arc} has no open question titled ${decision.title}` });
        }
        await port.airlock.triageQuestion(arc, decision.title, decision.choice);
        return digestAnswer(port, arc);
      }),
      deliverAirlock: memory.write(async (port, { slug }) => {
        const arc = slug ?? "";
        if ((await port.airlock.digest(arc)) === undefined) return noReview(arc);
        return { delivered: await port.airlock.deliverEligible(arc) };
      }),
      finishAirlock: memory.write(async (port, { slug }, request) => {
        const arc = slug ?? "";
        if ((await port.airlock.digest(arc)) === undefined) return noReview(arc);
        const force = fieldsOf<{ force: unknown }>(await bodyOf(request))?.force === true;
        return port.airlock.finish(arc, { force });
      }),
    };
  },
} satisfies RouteFamily<typeof airlockRoutes>;

export function decisionsOf(digest: ArcCloseDigestRecord): CloseDecisions {
  return {
    candidates: Object.fromEntries(
      digest.candidates.flatMap((candidate) =>
        candidate.choice === undefined ? [] : [[candidate.note, candidate.choice]],
      ),
    ),
    questions: Object.fromEntries(
      digest.questions.flatMap((question) =>
        question.choice === undefined ? [] : [[question.title, question.choice]],
      ),
    ),
    ...(digest.successor !== undefined && { successor: digest.successor }),
    ...(digest.direction !== undefined && { direction: digest.direction }),
  };
}

async function digestAnswer(port: MemoryPort, slug: string): Promise<unknown> {
  const digest = await port.airlock.digest(slug);
  if (digest === undefined) return noReview(slug);
  return { ...digest, decisions: decisionsOf(digest) };
}

function inertDigest(slug: string): ArcCloseDigestRecord & { decisions: CloseDecisions } {
  return { arc: slug, candidates: [], questions: [], decisions: { candidates: {}, questions: {} } };
}

function noReview(slug: string): Response {
  return json(404, { error: `no review is staged for arc ${slug}` });
}

function candidateChoiceOf(body: unknown): CandidateTriage | undefined {
  const choice = fieldsOf<{ choice: unknown }>(body)?.choice;
  return candidateChoices.find((known) => known === choice);
}

function questionDecisionOf(body: unknown): { title: string; choice: QuestionTriage } | undefined {
  const fields = fieldsOf<{ title: unknown; choice: unknown }>(body);
  const title = nonBlank(fields?.title);
  const choice = questionChoices.find((known) => known === fields?.choice);
  return title === undefined || choice === undefined ? undefined : { title, choice };
}
