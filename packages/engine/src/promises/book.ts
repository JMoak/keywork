import { sameReference } from "../inference/references.ts";
import type { ModelReference } from "../inference/types.ts";
import type { ModelClass } from "../models/policy/types.ts";
import type { ChoreJournal } from "../routines/service.ts";
import { choresRan, type StoppedChore, stoppedChores } from "./chores.ts";
import type { ModelEpisode, ModelSubject, ModelWatch } from "./models.ts";
import { offersModel, questionsOf } from "./questions.ts";
import { heldPromise, modelsReachable } from "./reachable.ts";
import type {
  AnsweredQuestion,
  AnswerRefusal,
  CreaturePromises,
  PromiseAnswer,
  PromiseEvidence,
  PromiseQuestion,
} from "./types.ts";

export interface PromiseSources {
  name(creature: string): Promise<string | undefined>;
  chores(creature: string): Promise<readonly ChoreJournal[]>;
  choreBound: number;
  models(creature: string): Promise<ModelSubject[]>;
  choreModel(creature: string): Promise<ModelReference | undefined>;
  workshop(creature: string): Promise<PromiseEvidence[]>;
  gates(creature: string): Promise<PromiseEvidence[]>;
  usable(): Promise<UsableModels>;
}

export type UsableModels = (classes: readonly ModelClass[]) => ModelReference[];

export type ActionOutcome = string | { refusal: string };

export interface PromiseActions {
  retryChore(creature: string, routineId: string): Promise<ActionOutcome>;
  turnOffChore(creature: string, routineId: string): Promise<ActionOutcome>;
  chooseModel(
    creature: string,
    classes: readonly ModelClass[],
    reference: ModelReference,
  ): Promise<ActionOutcome>;
}

export interface PromiseBookOptions {
  sources: PromiseSources;
  actions: PromiseActions;
  watch: ModelWatch;
}

export class PromiseBook {
  private readonly listeners = new Set<(view: CreaturePromises) => void>();
  private readonly last = new Map<string, string>();
  private readonly views = new Map<string, CreaturePromises>();

  constructor(private readonly options: PromiseBookOptions) {}

  async view(creature: string, look = false): Promise<CreaturePromises | undefined> {
    const { sources, watch } = this.options;
    const name = await sources.name(creature);
    if (name === undefined) return undefined;
    const [journals, subjects, choreModel, workshop, gates] = await Promise.all([
      sources.chores(creature),
      sources.models(creature),
      sources.choreModel(creature),
      sources.workshop(creature),
      sources.gates(creature),
    ]);
    if (look) await watch.look(subjects);
    const stopped = stoppedChores(journals);
    const silentTalk = watch.episodesOf(creature);
    const usable = asksAnything(stopped, silentTalk) ? await sources.usable() : noneUsable;
    const questions = questionsOf({
      creature,
      name,
      stopped,
      silentTalk,
      choreModel,
      findingOf: (reference) => watch.findingOf(reference),
      usable: (classes, instead) =>
        usable(classes)
          .filter((reference) => instead === undefined || !sameReference(reference, instead))
          .filter((reference) => watch.findingOf(reference)?.answered !== false),
    });
    const view: CreaturePromises = {
      creature,
      promises: [
        choresRan(journals, sources.choreBound),
        modelsReachable(creature, subjects, watch),
        heldPromise("workshop-healthy", workshop),
        heldPromise("gates-valid", gates),
      ],
      questions,
    };
    this.remember(view);
    return view;
  }

  async refresh(creature: string): Promise<void> {
    const view = await this.view(creature);
    if (view === undefined) this.forget(creature);
  }

  known(): CreaturePromises[] {
    return [...this.views.values()];
  }

  async answer(
    creature: string,
    questionId: string,
    answer: PromiseAnswer,
  ): Promise<AnsweredQuestion | AnswerRefusal> {
    const before = await this.view(creature);
    if (before === undefined) return "missing-creature";
    const question = before.questions.find(({ id }) => id === questionId);
    if (question === undefined) return "missing-question";
    if (!question.choices.some(({ id }) => id === answer.choice)) {
      const offered = question.choices.map(({ id }) => id).join(", ");
      return { refusal: `this question offers ${offered}`, status: 400 };
    }
    const done = await this.carryOut(question, answer);
    if (typeof done !== "string") return done;
    const promises = (await this.view(creature)) ?? before;
    return { question, done, promises };
  }

  subscribe(listener: (view: CreaturePromises) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.listeners.clear();
  }

  private async carryOut(
    question: PromiseQuestion,
    answer: PromiseAnswer,
  ): Promise<string | AnswerRefusal> {
    const { actions, watch } = this.options;
    const { creature, about } = question;
    switch (answer.choice) {
      case "retry": {
        if (about.model !== null) {
          const answered = await watch.tryAgain(creature, about.model);
          if (!answered) return { refusal: stillSilent, status: 409 };
          watch.settle(creature, about.model);
        }
        return this.each(
          about.chores,
          (id) => actions.retryChore(creature, id),
          answeredAgain(about.model),
        );
      }
      case "model": {
        const chosen = answer.model;
        if (chosen === undefined || !offersModel(question, chosen)) {
          return { refusal: "choose one of the models this question offers", status: 400 };
        }
        const classes: ModelClass[] = [
          ...(about.conversation ? (["strong"] as const) : []),
          ...(about.chores.length > 0 ? (["loop"] as const) : []),
        ];
        const chose = await actions.chooseModel(creature, classes, chosen);
        if (typeof chose !== "string") return { refusal: chose.refusal, status: 409 };
        if (about.model !== null) watch.settle(creature, about.model);
        return this.each(about.chores, (id) => actions.retryChore(creature, id), chose);
      }
      case "off":
        return this.each(about.chores, (id) => actions.turnOffChore(creature, id), "");
    }
  }

  private async each(
    chores: readonly string[],
    act: (routineId: string) => Promise<ActionOutcome>,
    first: string,
  ): Promise<string | AnswerRefusal> {
    const said = first === "" ? [] : [first];
    for (const routineId of chores) {
      const outcome = await act(routineId);
      if (typeof outcome !== "string") return { refusal: outcome.refusal, status: 409 };
      said.push(outcome);
    }
    return said.join(" ");
  }

  private remember(view: CreaturePromises): void {
    this.views.set(view.creature, view);
    const news = newsOf(view);
    if (this.last.get(view.creature) === news) return;
    this.last.set(view.creature, news);
    for (const listener of [...this.listeners]) listener(view);
  }

  private forget(creature: string): void {
    if (!this.views.delete(creature)) return;
    this.last.delete(creature);
    for (const listener of [...this.listeners]) {
      listener({ creature, promises: [], questions: [] });
    }
  }
}

function asksAnything(
  stopped: readonly StoppedChore[],
  silentTalk: readonly ModelEpisode[],
): boolean {
  return stopped.length > 0 || silentTalk.some((episode) => episode.outcome === "failed");
}

const noneUsable: UsableModels = () => [];

function newsOf({ promises, questions }: CreaturePromises): string {
  const findings = promises.map(({ state, evidence, repairs }) => ({
    state,
    evidence: evidence.map(({ subject, found, ok }) => ({ subject, found, ok })),
    repairs,
  }));
  return JSON.stringify({ findings, questions });
}

export const stillSilent = "Still no answer.";

function answeredAgain(model: ModelReference | null): string {
  return model === null ? "" : "Its model answers again.";
}
