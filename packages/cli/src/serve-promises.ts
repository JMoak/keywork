import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import {
  bindForClass,
  type ChoreJournal,
  type CreatureHost,
  type CreaturePatch,
  type CreaturePromises,
  type CreatureRegistry,
  type CreatureSessionKind,
  defaultSchedulerSettings,
  type GrantService,
  hostWorkshop,
  type InferenceBinding,
  isRefused,
  localityOf,
  type ModelClass,
  type ModelReference,
  type ModelSubject,
  ModelWatch,
  type ModelWork,
  modelClasses,
  PromiseBook,
  type PromiseEvidence,
  type ProviderRegistration,
  type RoutineService,
  SilentServerError,
  sameReference,
  serverRootOf,
  UnusableModelError,
  type Workshops,
} from "@keywork/engine";
import type { EventLog, ModelsPort, PromisesPort, WirePayload } from "@keywork/server";
import { toError } from "@keywork/shared";
import type { AskingTheServer } from "./serve-conversation-model.ts";
import { type ModelChoiceCheck, modelsReported } from "./serve-models.ts";

export interface TurnFacts {
  provider: string;
  model: string | undefined;
  creature: string | null;
  work: ModelWork | null;
}

export interface ServedPromisesOptions {
  workspace: string;
  workspaceState: string;
  log: Pick<EventLog, "subscribe">;
  registry: Pick<CreatureRegistry, "read" | "list">;
  creatures: Pick<CreatureHost, "update">;
  routines: () => RoutineService | undefined;
  workshops: Pick<Workshops, "list" | "health">;
  grants: () => Pick<GrantService, "list"> | undefined;
  models: Pick<ModelsPort, "probe">;
  registrations: () => readonly ProviderRegistration[];
  headersFor?:
    | ((registration: ProviderRegistration) => Record<string, string> | undefined)
    | undefined;
  inherit: () => ModelReference | undefined;
  check: ModelChoiceCheck | undefined;
  notice(text: string): void;
}

export interface ServedPromises {
  port: PromisesPort;
  book: PromiseBook;
  start(creatures: readonly string[]): Promise<CreaturePromises[]>;
  watchedAsk(ask: AskingTheServer): AskingTheServer;
  turnAnswered(turn: TurnFacts): void;
  turnFailed(turn: TurnFacts, error: Error): void;
  close(): void;
}

export function servedPromises(options: ServedPromisesOptions): ServedPromises {
  const registrationOf = (provider: string) =>
    options.registrations().find((registration) => registration.name === provider);
  const watch = new ModelWatch({
    file: join(options.workspaceState, "promises", "model-repairs.json"),
    probe: (endpoint, reference) =>
      answersAt(options, endpoint, reference.model, registrationOf(reference.provider)),
  });
  const subjects = (creature: string) => modelSubjectsOf(creature, options);
  const book = new PromiseBook({
    watch,
    sources: {
      name: async (creature) => (await options.registry.read(creature))?.file.name,
      chores: async (creature) => journalsOf(options.routines(), creature),
      choreBound: defaultSchedulerSettings.disableAfterErrors,
      models: subjects,
      choreModel: async (creature) =>
        (await subjects(creature)).find((subject) => subject.classes.includes("loop"))?.reference,
      workshop: (creature) => workshopEvidence(creature, options),
      gates: async (creature) =>
        gateEvidence(creature, await journalsOf(options.routines(), creature), options.grants()),
      usable: async () => {
        const reported = await modelsReported(
          options.models,
          options.registrations(),
          options.headersFor,
        );
        return (classes) => usableFor(options.check, classes, reported);
      },
    },
    actions: {
      retryChore: async (creature, routineId) =>
        sentenceOf(await options.routines()?.answer(creature, routineId, "retry")),
      turnOffChore: async (creature, routineId) =>
        sentenceOf(await options.routines()?.answer(creature, routineId, "off")),
      chooseModel: (creature, classes, reference) =>
        chooseModel(options.creatures, creature, classes, reference),
    },
  });
  const refreshing = refresher(book, options);
  const unwatch = watch.subscribe((creature) => refreshing(creature));
  const unfollow = options.log.subscribe(({ type, payload }) => {
    const creature = creatureOfEvent(type, payload);
    if (creature !== undefined) refreshing(creature);
  });
  return {
    port: {
      view: (creature) => book.view(creature, true),
      answer: (creature, questionId, answer) => book.answer(creature, questionId, answer),
      subscribe: (listener) => book.subscribe(listener),
    },
    book,
    start: async (creatures) => {
      const views: CreaturePromises[] = [];
      for (const creature of creatures) {
        const view = await book
          .view(creature)
          .catch((cause: unknown) =>
            options.notice(`the promises of ${creature} were not read: ${toError(cause).message}`),
          );
        if (view !== undefined) views.push(view);
      }
      return views;
    },
    watchedAsk: (ask) => async (binding, need) => {
      try {
        await ask(binding, need);
      } catch (cause) {
        if (cause instanceof SilentServerError && need !== undefined) {
          watch.silent(binding.reference, cause.endpoint, need);
        }
        throw cause;
      }
    },
    turnAnswered: (turn) => {
      const reference = referenceOfTurn(turn);
      if (reference === undefined) return;
      watch.heard(reference, localRootOf(registrationOf(turn.provider)));
    },
    turnFailed: (turn, error) => {
      const reference = referenceOfTurn(turn);
      const root = localRootOf(registrationOf(turn.provider));
      if (reference === undefined || root === null || turn.creature === null || turn.work === null)
        return;
      if (!isConnectionFailure(error)) return;
      watch.silent(reference, root, { creature: turn.creature, work: turn.work });
    },
    close: () => {
      unwatch();
      unfollow();
      watch.close();
      book.close();
    },
  };
}

async function answersAt(
  options: Pick<ServedPromisesOptions, "models" | "headersFor">,
  endpoint: string,
  model: string,
  registration: ProviderRegistration | undefined,
): Promise<boolean> {
  const headers = registration === undefined ? undefined : options.headersFor?.(registration);
  const report = await options.models.probe({
    endpoint,
    model,
    ...(headers !== undefined && { headers }),
  });
  return !("status" in report) || report.status !== "unreachable";
}

async function journalsOf(
  routines: RoutineService | undefined,
  creature: string,
): Promise<ChoreJournal[]> {
  const journals = await routines?.journalOf(creature);
  return journals === undefined || typeof journals === "string" ? [] : journals;
}

async function modelSubjectsOf(
  creature: string,
  options: Pick<ServedPromisesOptions, "registry" | "inherit" | "registrations">,
): Promise<ModelSubject[]> {
  const found = await options.registry.read(creature);
  if (found === undefined) return [];
  const subjects: ModelSubject[] = [];
  for (const modelClass of modelClasses) {
    const slot = found.file.models[modelClass];
    const inherited = slot === "inherit";
    if (inherited && modelClass !== "strong" && modelClass !== "loop") continue;
    const reference = inherited ? options.inherit() : slot;
    if (reference === undefined) continue;
    const known = subjects.find((subject) => sameReference(subject.reference, reference));
    if (known !== undefined) {
      known.classes.push(modelClass);
      continue;
    }
    subjects.push(subjectOf(reference, modelClass, options.registrations()));
  }
  return subjects;
}

function subjectOf(
  reference: ModelReference,
  modelClass: ModelClass,
  registrations: readonly ProviderRegistration[],
): ModelSubject {
  const bound = bindForClass(reference, modelClass, registrations);
  if (!bound.ok) {
    return { reference, classes: [modelClass], endpoint: null, refusal: bound.failure.message };
  }
  return {
    reference,
    classes: [modelClass],
    endpoint: localRootOf(bound.binding.registration),
    refusal: null,
  };
}

function localRootOf(registration: Pick<InferenceBinding["registration"], "endpoint"> | undefined) {
  if (registration === undefined || localityOf(registration.endpoint) !== "local") return null;
  return serverRootOf(registration.endpoint);
}

async function workshopEvidence(
  creature: string,
  options: Pick<ServedPromisesOptions, "registry" | "workspace" | "workshops">,
): Promise<PromiseEvidence[]> {
  const found = await options.registry.read(creature);
  if (found === undefined) return [];
  const checkedAt = new Date().toISOString();
  const { workshop } = found.file;
  if (workshop === hostWorkshop) {
    const writable = await access(options.workspace, constants.W_OK).then(
      () => undefined,
      (cause: unknown) => toError(cause).message,
    );
    return [
      {
        subject: "this host",
        checkedAt,
        found:
          writable === undefined
            ? "its workspace folder is there and writable"
            : `its workspace folder cannot be written: ${writable}`,
        ok: writable === undefined,
      },
    ];
  }
  const listed = (await options.workshops.list()).find((view) => view.id === workshop);
  if (listed === undefined) {
    return [{ subject: workshop, checkedAt, found: "this machine does not know it", ok: false }];
  }
  if (listed.state === "stopped") {
    return [
      {
        subject: workshop,
        checkedAt,
        found: "stopped; it starts on the creature's first tool call",
        ok: true,
      },
    ];
  }
  const health = await options.workshops.health(workshop);
  if (isRefused(health)) {
    return [{ subject: workshop, checkedAt, found: `did not answer: ${health.error}`, ok: false }];
  }
  return [
    {
      subject: workshop,
      checkedAt,
      found: healthWords[health.health],
      ok: health.health === "up" ? true : health.health === "starting" ? null : false,
    },
  ];
}

const healthWords = {
  up: "runs and answers",
  starting: "is starting",
  unresponsive: "runs but does not answer",
  down: "runs but is down",
} as const;

function gateEvidence(
  creature: string,
  journals: readonly ChoreJournal[],
  grants: Pick<GrantService, "list"> | undefined,
): PromiseEvidence[] {
  const chores = journals.flatMap(({ view, acceptedDigest }): PromiseEvidence[] => {
    const held = view.grants;
    if (view.routine === null || held === null || !held.needsAcceptance) return [];
    const subject = `what "${view.routine.title}" may do`;
    if (held.accepted) {
      return [{ subject, checkedAt: held.acceptedAt, found: "the one you accepted", ok: true }];
    }
    return [
      {
        subject,
        checkedAt: null,
        found:
          acceptedDigest === null
            ? "waits for you to accept it"
            : "changed since you accepted it, so it waits for you again",
        ok: acceptedDigest === null ? null : false,
      },
    ];
  });
  const mesh = (grants?.list().issued ?? [])
    .filter((grant) => grant.subject.creature === creature)
    .map(
      (grant): PromiseEvidence => ({
        subject: `the gate onto ${grant.target}`,
        checkedAt: grant.issuedAt,
        found: `signed by you, open until ${grant.expiresAt}`,
        ok: true,
      }),
    );
  return [...chores, ...mesh];
}

function usableFor(
  check: ModelChoiceCheck | undefined,
  classes: readonly ModelClass[],
  reported: readonly ModelReference[],
): ModelReference[] {
  if (check === undefined || classes.length === 0) return [];
  const [first, ...rest] = classes;
  if (first === undefined) return [];
  return check
    .usableFor(first, reported)
    .filter((reference) =>
      rest.every((modelClass) => check.refusalOf(modelClass, reference) === undefined),
    );
}

async function chooseModel(
  creatures: Pick<CreatureHost, "update">,
  creature: string,
  classes: readonly ModelClass[],
  reference: ModelReference,
): Promise<string | { refusal: string }> {
  const models = Object.fromEntries(classes.map((modelClass) => [modelClass, reference]));
  try {
    const updated = await creatures.update(creature, { models } as CreaturePatch);
    if (updated === undefined) return { refusal: "no creature has that slug" };
  } catch (cause) {
    if (cause instanceof UnusableModelError) return { refusal: cause.message };
    throw cause;
  }
  const uses = classes.map((modelClass) =>
    modelClass === "strong" ? "when you talk" : "for its chores",
  );
  return `The model you chose answers ${uses.join(" and ")} from now on.`;
}

function sentenceOf(
  outcome: Awaited<ReturnType<RoutineService["answer"]>> | undefined,
): string | { refusal: string } {
  if (outcome === undefined) return { refusal: "this workspace runs no chores" };
  if (outcome === "missing-creature") return { refusal: "no creature has that slug" };
  if (outcome === "missing-routine") return { refusal: "that chore is gone" };
  if ("refusal" in outcome) return outcome;
  return outcome.done;
}

function refresher(
  book: PromiseBook,
  options: Pick<ServedPromisesOptions, "registry" | "notice">,
): (creature: string | null) => void {
  const due = new Set<string>();
  let armed = false;
  const flush = async () => {
    armed = false;
    const creatures = [...due];
    due.clear();
    for (const creature of creatures) {
      await book
        .refresh(creature)
        .catch((cause: unknown) =>
          options.notice(`the promises of ${creature} were not read: ${toError(cause).message}`),
        );
    }
  };
  const soon = (creatures: readonly string[]) => {
    for (const creature of creatures) due.add(creature);
    if (armed) return;
    armed = true;
    setTimeout(() => void flush(), refreshAfterMs).unref?.();
  };
  return (creature) => {
    if (creature !== null) return soon([creature]);
    void options.registry
      .list()
      .then((all) => soon(all.map(({ slug }) => slug)))
      .catch(() => undefined);
  };
}

const refreshAfterMs = 150;

function creatureOfEvent(type: string, payload: unknown): string | null | undefined {
  switch (type) {
    case "routine.finished":
      return (payload as WirePayload<"routine.finished">).run.creature;
    case "routine.needs":
    case "routine.checked":
    case "routine.fired":
      return (payload as { creature: string }).creature;
    case "creature.changed":
      return (payload as WirePayload<"creature.changed">).slug;
    case "workshop.changed":
      return (payload as WirePayload<"workshop.changed">).workshop.creature;
    case "models.changed":
      return null;
    default:
      return undefined;
  }
}

export function workOf(kind: CreatureSessionKind | undefined): ModelWork | null {
  if (kind === "conversation") return "conversation";
  return kind === "routine" ? "chore" : null;
}

function referenceOfTurn(turn: TurnFacts): ModelReference | undefined {
  return turn.model === undefined ? undefined : { provider: turn.provider, model: turn.model };
}

const connectionCodes = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ETIMEDOUT",
  "ConnectionRefused",
  "ConnectionClosed",
  "FailedToOpenSocket",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function isConnectionFailure(error: unknown): boolean {
  for (let cause = error, depth = 0; cause !== undefined && depth < 5; depth++) {
    if (cause instanceof SilentServerError) return true;
    const code = (cause as { code?: unknown } | null)?.code;
    if (typeof code === "string" && connectionCodes.has(code)) return true;
    const message = cause instanceof Error ? cause.message : "";
    if (/unable to connect|connection refused|fetch failed/i.test(message)) return true;
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return false;
}
