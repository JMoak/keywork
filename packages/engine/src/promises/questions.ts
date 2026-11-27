import { createHash } from "node:crypto";
import { formatReference, sameReference } from "../inference/references.ts";
import type { ModelReference } from "../inference/types.ts";
import type { ModelClass } from "../models/policy/types.ts";
import type { StoppedChore } from "./chores.ts";
import type { ModelEpisode, ModelFinding } from "./models.ts";
import type { PromiseChoice, PromiseQuestion } from "./types.ts";

export interface QuestionFacts {
  creature: string;
  name: string;
  stopped: readonly StoppedChore[];
  silentTalk: readonly ModelEpisode[];
  choreModel: ModelReference | undefined;
  findingOf(reference: ModelReference): ModelFinding | undefined;
  usable(classes: readonly ModelClass[], instead: ModelReference | undefined): ModelReference[];
}

export function questionsOf(facts: QuestionFacts): PromiseQuestion[] {
  const silentChoreModel =
    facts.choreModel !== undefined && facts.findingOf(facts.choreModel)?.answered === false
      ? facts.choreModel
      : undefined;
  const groups = new Map<string, Group>();
  for (const episode of facts.silentTalk) {
    if (episode.outcome !== "failed") continue;
    groupOf(groups, modelQuestionId(episode.reference), {
      model: episode.reference,
      endpoint: episode.endpoint,
      since: episode.endedAt ?? episode.startedAt,
    }).conversation = true;
  }
  for (const chore of facts.stopped) {
    const model = chore.byCheck ? undefined : silentChoreModel;
    const group =
      model === undefined
        ? groupOf(groups, choreQuestionId(chore.routineId), { since: chore.since, cause: chore })
        : groupOf(groups, modelQuestionId(model), {
            model,
            endpoint: facts.findingOf(model)?.endpoint ?? null,
            since: chore.since,
          });
    group.chores.push(chore);
  }
  return [...groups.entries()].map(([id, group]) => questionOf(id, group, facts));
}

export function modelQuestionId(reference: ModelReference): string {
  const digest = createHash("sha256").update(formatReference(reference)).digest("hex");
  return `model-${digest.slice(0, 12)}`;
}

export function choreQuestionId(routineId: string): string {
  return `chore-${routineId}`;
}

interface Group {
  model: ModelReference | undefined;
  endpoint: string | null;
  since: string;
  cause: StoppedChore | undefined;
  conversation: boolean;
  chores: StoppedChore[];
}

function groupOf(
  groups: Map<string, Group>,
  id: string,
  seed: Partial<Pick<Group, "model" | "endpoint" | "cause">> & { since: string },
): Group {
  const existing = groups.get(id);
  if (existing !== undefined) {
    if (seed.since < existing.since) existing.since = seed.since;
    return existing;
  }
  const group: Group = {
    model: seed.model,
    endpoint: seed.endpoint ?? null,
    since: seed.since,
    cause: seed.cause,
    conversation: false,
    chores: [],
  };
  groups.set(id, group);
  return group;
}

function questionOf(id: string, group: Group, facts: QuestionFacts): PromiseQuestion {
  const classes: ModelClass[] = [
    ...(group.conversation ? (["strong"] as const) : []),
    ...(group.chores.length > 0 ? (["loop"] as const) : []),
  ];
  const byCheck = group.cause?.byCheck === true;
  const instead = group.model ?? (group.chores.length > 0 ? facts.choreModel : undefined);
  const models = byCheck ? [] : facts.usable(classes, instead);
  const choices: PromiseChoice[] = [
    { id: "retry", label: "Try again" },
    ...(models.length > 0 ? [{ id: "model" as const, label: "Choose another model", models }] : []),
    ...(group.chores.length > 0 && !group.conversation
      ? [
          {
            id: "off" as const,
            label: group.chores.length === 1 ? "Turn the chore off" : "Turn the chores off",
          },
        ]
      : []),
  ];
  return {
    id,
    creature: facts.creature,
    promise: group.model === undefined ? "chores-ran" : "models-reachable",
    sentence: sentenceOf(group, facts.name),
    address: group.model === undefined ? null : group.endpoint,
    lastFailure: group.model === undefined ? lastFailureOf(group) : null,
    since: group.since,
    choices,
    about: {
      chores: group.chores.map((chore) => chore.routineId),
      conversation: group.conversation,
      model: group.model ?? null,
    },
  };
}

function sentenceOf(group: Group, name: string): string {
  const chores = listed(group.chores.map((chore) => quoted(chore.title)));
  if (group.model !== undefined) {
    const silent = `${name}'s model is not answering`;
    if (!group.conversation) return `${chores} did not run: ${silent}.`;
    const missed = chores === "" ? "" : `, so ${chores} did not run`;
    return `${silent}${missed}. Is its server running?`;
  }
  const chore = group.cause ?? group.chores[0];
  const title = `${name}'s chore ${quoted(chore?.title ?? "")}`;
  return chore?.byCheck === true
    ? `${title} stopped: its check kept failing. Try it again?`
    : `${title} kept failing, so it stopped. Try it again?`;
}

function lastFailureOf(group: Group): string | null {
  const chore = group.cause ?? group.chores[0];
  return chore === undefined ? null : withoutStop(chore.reason);
}

function listed(items: readonly string[]): string {
  return items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function quoted(title: string): string {
  return `"${title}"`;
}

function withoutStop(text: string): string {
  return text.trim().replace(/[.\s]+$/, "");
}

export function offersModel(question: PromiseQuestion, reference: ModelReference): boolean {
  return question.choices.some(
    (choice) =>
      choice.id === "model" && choice.models.some((offered) => sameReference(offered, reference)),
  );
}
