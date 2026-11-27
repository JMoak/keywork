import type {
  AnsweredQuestion,
  AnswerRefusal,
  ChoiceId,
  CreaturePromises,
  ModelReference,
  PromiseAnswer,
} from "@keywork/engine";
import { servedBy } from "./answers.ts";
import {
  bodyOf,
  fieldsOf,
  type JsonSchema,
  json,
  type RouteFamily,
  type RouteSpec,
} from "./family.ts";

export interface PromisesPort {
  view(creature: string): Promise<CreaturePromises | undefined>;
  answer(
    creature: string,
    questionId: string,
    answer: PromiseAnswer,
  ): Promise<AnsweredQuestion | AnswerRefusal>;
  subscribe(listener: (view: CreaturePromises) => void): () => void;
}

const choiceIds: readonly ChoiceId[] = ["retry", "model", "off"];

const answerBody: JsonSchema = {
  type: "object",
  required: ["choice"],
  properties: {
    choice: { type: "string", enum: [...choiceIds] },
    model: {
      type: "object",
      required: ["provider", "model"],
      properties: { provider: { type: "string" }, model: { type: "string" } },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

const answerShape = "the body must be { choice: retry | model | off, model?: { provider, model } }";

export const promiseRoutes = [
  {
    method: "GET",
    path: "/creatures/{slug}/promises",
    operationId: "readCreaturePromises",
    summary:
      "What the creature keeps, with the evidence: `{ creature, promises, questions }`. `promises` is always four, in this order, each `{ kind, state, checks, evidence, repairs }`: `chores-ran`, `models-reachable`, `workshop-healthy` and `gates-valid`. `state` is `kept`, `repairing`, `broken` or `unknown` (nothing to judge yet). `checks` says in one plain paragraph exactly what the engine checks for that promise today. `evidence` is one row per thing checked, `{ subject, checkedAt, found, ok }` (`ok` null when there is nothing to judge). `repairs` is each repair episode still worth knowing, `{ subject, startedAt, tries, bound, nextAt, endedAt, outcome }` with `outcome` `repairing`, `repaired` or `failed`: a chore that fails is run again on its own with backoff, at most five times in a row; a model server that stops answering while the creature talks with you is asked again three times over about three and a half minutes. A repair that works is recorded here and tells nobody. One that fails ends in a question in `questions`, `{ id, creature, promise, sentence, address, lastFailure, since, choices, about }`: one per cause, so a chore stopped because its model server is silent shares the question about that model. `sentence` asks it in a keeper's words and names the creature, with no model, address or engine word; the detail is in fields of its own: the silent model in `about.model`, `address` the address its server was asked at (null when the cause is not a silent model), and `lastFailure` what failed the last time in the engine's words (null for a silent model). `choices` lists what would fix it, each `{ id, label }`: `retry`, `model` (with `models`, the `{ provider, model }` references that would answer for the work waiting: for each model server connected on the stead, the models it reports when asked now, whether or not its connection lists any, and none from a server that does not answer; for a market provider, the models it lists) and `off` (when only chores wait). `about` says what waits: `{ chores, conversation, model }`. Reading this asks each local model server the creature uses whether it answers, at most once every 20 s; it spends no tokens. `creature.promises` carries the same body whenever it changes. Since contract 1.41.",
    authenticated: true,
    responses: {
      "200": "`{ creature, promises, questions }`.",
      "404": "No creature has that slug.",
      "503": "This host keeps no promises.",
    },
  },
  {
    method: "POST",
    path: "/creatures/{slug}/questions/{id}",
    operationId: "answerCreatureQuestion",
    summary:
      "The keeper answers a question a failed repair asked. The body is `{ choice }`, one of the question's `choices`, and for `model` also `model: { provider, model }`, one of the models it offers. `retry` asks a silent model server again first (and answers 409 with the error `Still no answer.` when it still does not answer, leaving the question), then runs each chore it waits for once at once: a chore that fails that one try stops again and asks again, never a silent loop. `model` sets the creature's model for the work waiting (talking with you, its chores, or both), exactly as `PATCH /creatures/{slug}` would, then runs the chores once. `off` turns the chores off in their files; they run again only when the keeper turns them on. Answers `{ question, done, promises }`: `done` says in plain words what was done. `creature.promises` follows. Since contract 1.41.",
    authenticated: true,
    requestBody: answerBody,
    responses: {
      "200": "`{ question, done, promises }`.",
      "400": "The body is not an answer, or names a choice or a model the question does not offer.",
      "404": "No creature has that slug, or it has no open question with that id.",
      "409":
        "`{ error }`: the choice could not be carried out, in words (a model server still silent, a model that would not answer, a chore that could not be run).",
      "503": "This host keeps no promises.",
    },
  },
] as const satisfies readonly RouteSpec[];

export const promiseFamily = {
  routes: promiseRoutes,
  handlers: ({ host, log, streams }) => {
    if (host.promises !== undefined) {
      streams.add(host.promises.subscribe((view) => log.record("", "creature.promises", view)));
    }
    const promises = servedBy((): PromisesPort | undefined => host.promises, "promises");
    return {
      readCreaturePromises: promises(async (port, _request, { slug = "" }) => {
        const view = await port.view(slug);
        return view === undefined
          ? json(404, { error: "no creature has that slug" })
          : json(200, view);
      }),
      answerCreatureQuestion: promises(async (port, request, { slug = "", id = "" }) => {
        const answer = answerOf(await bodyOf(request));
        if (answer === undefined) return json(400, { error: answerShape });
        const outcome = await port.answer(slug, id, answer);
        if (outcome === "missing-creature")
          return json(404, { error: "no creature has that slug" });
        if (outcome === "missing-question") {
          return json(404, { error: "that creature has no open question with that id" });
        }
        if ("refusal" in outcome) return json(outcome.status, { error: outcome.refusal });
        return json(200, outcome);
      }),
    };
  },
} satisfies RouteFamily<typeof promiseRoutes>;

function answerOf(body: unknown): PromiseAnswer | undefined {
  const fields = fieldsOf<{ choice: unknown; model: unknown }>(body);
  if (fields === undefined) return undefined;
  const choice = choiceIds.find((id) => id === fields.choice);
  if (choice === undefined) return undefined;
  if (fields.model === undefined) return { choice };
  const model = referenceOf(fields.model);
  return model === undefined ? undefined : { choice, model };
}

function referenceOf(value: unknown): ModelReference | undefined {
  const fields = fieldsOf<{ provider: unknown; model: unknown }>(value);
  if (typeof fields?.provider !== "string" || typeof fields.model !== "string") return undefined;
  if (fields.provider === "" || fields.model === "") return undefined;
  return { provider: fields.provider, model: fields.model };
}
